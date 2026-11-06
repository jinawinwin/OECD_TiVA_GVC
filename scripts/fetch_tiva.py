"""OECD TiVA 데이터 수집 (GitHub Actions에서 실행).

    python scripts/fetch_tiva.py                # 새 판(edition) 또는 설정 변경이 있을 때만 다시 수집
    python scripts/fetch_tiva.py --force        # 무조건 다시 수집
    python scripts/fetch_tiva.py --check-only   # 구조만 확인하고 변경 여부를 출력

config/tiva.yaml의 blocks마다 data/processed/tiva_<블록>.parquet을 만든다. 열은 해당 dataflow의
차원 id(FREQ 제외)와 year, value, unit_mult이다. 사용한 dataflow와 판, 행 수는 manifest.json에 남긴다.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import logging
import os
import sys
from pathlib import Path

import pandas as pd
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sdmx import Flow, FlowStructure, NoResults, SdmxClient, TooLarge, empty_frame, plan_chunks, split_once  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
log = logging.getLogger("tiva.fetch")


def load_yaml(p: Path) -> dict:
    with open(p, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def config_hash(cfg: dict) -> str:
    return hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest()[:16]


def frame_hash(df: pd.DataFrame) -> str:
    if df.empty:
        return "empty"
    h = pd.util.hash_pandas_object(df.reset_index(drop=True), index=False)
    return hashlib.sha256(h.values.tobytes()).hexdigest()[:16]


def gh_output(**kv):
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as fh:
            for k, v in kv.items():
                fh.write(f"{k}={v}\n")


def year_spans(years: list[int]) -> list[tuple[int, int]]:
    """연속된 연도를 묶어 요청 횟수를 줄인다. [2000, 2005, 2018, 2019] -> [(2000,2000), (2005,2005), (2018,2019)]"""
    spans = []
    for y in sorted(set(years)):
        if spans and y == spans[-1][1] + 1:
            spans[-1] = (spans[-1][0], y)
        else:
            spans.append((y, y))
    return spans


class Fetcher:
    def __init__(self, cfg: dict, cache_dir: Path, base_url: str | None = None):
        src = cfg["source"]
        self.cfg = cfg
        self.client = SdmxClient(base_url or src["base_url"], src["agency"],
                                 min_interval=float(os.environ.get("TIVA_MIN_INTERVAL", src["min_request_interval_sec"])),
                                 timeout=src["timeout_sec"], max_retries=src["max_retries"])
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.flows: list[Flow] = []
        self.structures: dict[str, FlowStructure] = {}
        self.missing: dict[str, dict[str, list[str]]] = {}

    # ------------------------------------------------------------ discovery
    def discover(self):
        src = self.cfg["source"]
        flows = [f for f in self.client.dataflows() if src["flow_keyword"].upper() in f.id.upper()]
        if not flows:
            raise RuntimeError(f"'{src['flow_keyword']}'를 포함한 dataflow가 없습니다")
        editions = [f.edition for f in flows if f.edition]
        if editions:
            latest = max(editions)
            flows = [f for f in flows if f.edition in (latest, None)]
        self.flows = sorted(flows, key=lambda f: f.id)
        for f in self.flows:
            log.info("TiVA dataflow %s v%s (%s)%s", f.id, f.version, f.name,
                     f" -> {f.service_base}" if f.service_base else "")

    def flow_for(self, keyword: str) -> Flow:
        cands = [f for f in self.flows if keyword.upper() in f.id.upper()]
        if not cands:
            raise RuntimeError(f"'{keyword}' dataflow를 찾지 못했습니다. 있는 것: {[f.id for f in self.flows]}")
        return sorted(cands, key=lambda f: (len(f.id), f.id))[0]

    def structure(self, flow: Flow) -> FlowStructure:
        if flow.id not in self.structures:
            fs = self.client.structure(flow)
            self.structures[flow.id] = fs
            log.info("  %s 차원 %s, 기간 %s", flow.id, fs.dims, fs.time_range)
        return self.structures[flow.id]

    def latest_year(self) -> int:
        fs = self.structure(self.flow_for(self.cfg["blocks"]["levels"]["flow"]))
        return fs.time_range[1] or dt.date.today().year - 3

    def partner_years(self) -> list[int]:
        y = self.cfg["years"]
        latest = self.latest_year()
        return sorted({v for v in y["partner_benchmark"] if v <= latest} |
                      set(range(latest - y["partner_recent"] + 1, latest + 1)))

    # ------------------------------------------------------------- selection
    def expand(self, spec, dim: str = "") -> list[str]:
        """코드 묶음 이름을 코드로 펼친다. 산업 차원은 activities, 그 밖은 codes의 묶음을 쓴다."""
        if "ACTIVITY" in dim:
            pools = dict(self.cfg["activities"])
        else:
            pools = {k: v for k, v in self.cfg["codes"].items() if isinstance(v, list)}
        out = []
        for s in spec if isinstance(spec, list) else [spec]:
            out += pools.get(s, [s])
        return list(dict.fromkeys(out))

    def selection(self, name: str, fs: FlowStructure, block: dict) -> dict[str, list[str]]:
        sel = {}
        for dim, spec in block["dims"].items():
            if dim not in fs.dims:
                raise RuntimeError(f"[{name}] {fs.flow.id}에 {dim} 차원이 없습니다 (차원 {fs.dims})")
            want = self.expand(spec, dim)
            got, miss = [], []
            for c in want:
                real = fs.resolve_code(dim, c)
                (got if real else miss).append(real or c)
            if miss:
                self.missing.setdefault(name, {})[dim] = miss
                log.warning("[%s] %s에 없는 코드 %d개 제외: %s", name, dim, len(miss), miss[:12])
            if not got:
                raise RuntimeError(f"[{name}] {dim}에서 쓸 수 있는 코드가 없습니다")
            sel[dim] = got
        return sel

    # ------------------------------------------------------------- download
    def _cached(self, fs: FlowStructure, sel: dict, start: int, end: int, reduce: dict | None = None) -> pd.DataFrame:
        tag = json.dumps([fs.flow.id, fs.flow.version, sel, start, end, reduce], sort_keys=True)
        path = self.cache_dir / (hashlib.sha256(tag.encode()).hexdigest()[:20] + ".parquet")
        if path.exists():
            return pd.read_parquet(path)
        try:
            df = self.client.data(fs, sel, start, end)
        except NoResults:
            df = empty_frame(fs.dims)
        if reduce:
            df = reduce_foreign(df, reduce["source"], reduce["exporter"])
        df.to_parquet(path, index=False)
        return df

    def download(self, name: str, block: dict) -> pd.DataFrame:
        src = self.cfg["source"]
        flow = self.flow_for(block["flow"])
        fs = self.structure(flow)
        sel = self.selection(name, fs, block)
        if block.get("years", "all") == "partner":
            spans = year_spans(self.partner_years())
        else:
            t0, t1 = fs.time_range
            spans = [(block.get("start_year") or t0 or 1995, t1 or self.latest_year())]

        def key_len(s):
            return len(self.client.build_key(fs, s))

        reduce = block.get("reduce")
        max_obs = block.get("max_obs", src["max_obs_per_query"])
        queue = []
        for s, e in spans:
            queue += plan_chunks(sel, s, e, max_obs, key_len, src["max_key_length"])
        log.info("[%s] %s, 연도 %s, 요청 %d건 예정", name, flow.id, spans, len(queue))
        frames, done = [], 0
        while queue:
            sel_c, s, e = queue.pop(0)
            try:
                df = self._cached(fs, sel_c, s, e, reduce)
            except TooLarge:
                halves = split_once(sel_c, s, e)
                if not halves:
                    raise
                log.info("  응답이 커서 요청을 나눕니다")
                queue = halves + queue
                continue
            done += 1
            frames.append(df)
            log.info("  %d/%d 완료 (%s~%s, %s행)", done, done + len(queue), s, e, f"{len(df):,}")
        out = pd.concat([f for f in frames if not f.empty] or [empty_frame(fs.dims)], ignore_index=True)
        dims = [c for c in out.columns if c not in ("year", "value", "unit_mult")]
        if block.get("years") == "partner":
            out = out[out["year"].isin(self.partner_years())]
        if reduce and not out.empty:   # 수출 경제를 나눠 받은 조각의 부분합을 다시 더한다
            out = out.groupby(dims + ["year"], as_index=False, sort=False).agg(value=("value", "sum"), unit_mult=("unit_mult", "first"))
        out = out.drop_duplicates(subset=dims + ["year"]).sort_values(dims + ["year"]).reset_index(drop=True)
        for c in dims:
            out[c] = out[c].astype(str)
        if "MEASURE" in out:
            log.info("[%s] %s행, 지표별 행 수 %s", name, f"{len(out):,}", out["MEASURE"].value_counts().to_dict())
        return out


def reduce_foreign(df: pd.DataFrame, source: str, exporter: str) -> pd.DataFrame:
    """원천 경제 자신을 뺀 수출 경제들의 합계로 줄인다. 수출 경제 열은 'FOREIGN'이 된다."""
    if df.empty:
        return df
    d = df[df[exporter] != df[source]]
    keys = [c for c in df.columns if c not in ("value", "unit_mult", exporter)]
    out = d.groupby(keys, as_index=False, sort=False).agg(value=("value", "sum"), unit_mult=("unit_mult", "first"))
    out[exporter] = "FOREIGN"
    return out[df.columns.tolist()]


def write_codelists(fetcher: Fetcher, path: Path):
    out = {"area": {}, "activity": {}, "measure": {}, "unit": {}}
    for fs in fetcher.structures.values():
        for dim in fs.dims:
            key = ("area" if "AREA" in dim else "activity" if "ACTIVITY" in dim else
                   "measure" if dim == "MEASURE" else "unit" if dim == "UNIT_MEASURE" else None)
            if key:
                for code, name in fs.codelists.get(dim, {}).items():
                    out[key].setdefault(code, name)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "config/tiva.yaml"))
    ap.add_argument("--out", default=str(ROOT / "data/processed"))
    ap.add_argument("--cache", default=str(ROOT / "data/cache"))
    ap.add_argument("--base-url", default=os.environ.get("TIVA_BASE_URL"))
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--check-only", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    cfg = load_yaml(Path(args.config))
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.json"
    old = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}

    fetcher = Fetcher(cfg, Path(args.cache), args.base_url)
    fetcher.discover()
    signature = {"flows": sorted([[f.id, f.version, f.name] for f in fetcher.flows]), "config": config_hash(cfg)}
    have_all = all((out_dir / f"tiva_{b}.parquet").exists() for b in cfg["blocks"])
    if old.get("signature") == signature and have_all and not args.force:
        log.info("OECD 판과 설정이 이전 수집과 같아 다시 받지 않습니다 (--force로 강제 수집)")
        gh_output(changed="false")
        return
    if args.check_only:
        log.info("변경 감지: 새 판 또는 설정 변경")
        gh_output(changed="true")
        return

    rows, hashes, measures, changed = {}, {}, {}, False
    for name, block in cfg["blocks"].items():
        df = fetcher.download(name, block)
        if df.empty:
            raise RuntimeError(f"[{name}] 받은 데이터가 없습니다")
        h = frame_hash(df)
        path = out_dir / f"tiva_{name}.parquet"
        if old.get("hash", {}).get(name) != h or not path.exists():
            df.to_parquet(path, index=False, compression="zstd")
            changed = True
        rows[name], hashes[name] = len(df), h
        if "MEASURE" in df:
            measures[name] = sorted(df["MEASURE"].unique().tolist())
    write_codelists(fetcher, out_dir / "codelists.json")

    used = {fetcher.flow_for(b["flow"]).id for b in cfg["blocks"].values()}
    manifest = {
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": cfg["source"]["base_url"],
        "agency": cfg["source"]["agency"],
        "edition": max((f.edition for f in fetcher.flows if f.edition), default=None),
        "flows": [{"id": f.id, "version": f.version, "name": f.name, "service": f.service_base}
                  for f in fetcher.flows if f.id in used],
        "blocks": {name: {"flow": fetcher.flow_for(b["flow"]).id, "rows": rows[name], "measures": measures.get(name)}
                   for name, b in cfg["blocks"].items()},
        "missing_codes": fetcher.missing,
        "latest_year": fetcher.latest_year(),
        "partner_years": fetcher.partner_years(),
        "requests": fetcher.client.n_requests,
        "signature": signature,
        "hash": hashes,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    log.info("완료: %s, 요청 %d건", {k: f"{v:,}" for k, v in rows.items()}, fetcher.client.n_requests)
    gh_output(changed="true" if changed else "false")


if __name__ == "__main__":
    main()
