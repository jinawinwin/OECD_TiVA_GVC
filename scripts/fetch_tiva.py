"""OECD TiVA 데이터 수집 (GitHub Actions에서 실행).

    python scripts/fetch_tiva.py                # 새 판(edition) 또는 설정 변경이 있을 때만 다시 수집
    python scripts/fetch_tiva.py --force        # 무조건 다시 수집
    python scripts/fetch_tiva.py --check-only   # 구조만 확인하고 변경 여부를 출력

출력
    data/processed/tiva_country_industry.parquet   국가 × 산업 × 연도 (상대국 = 세계)
    data/processed/tiva_partner.parquet            국가 × 상대국 × 산업 × 선택 연도
    data/processed/codelists.json                  코드별 영문 명칭
    data/processed/manifest.json                   사용한 dataflow, 판, 행 수, 데이터 해시
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
from sdmx import (FlowStructure, NoResults, SdmxClient, TooLarge, assign_roles, empty_frame,  # noqa: E402
                  plan_chunks, split_once)

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


class Fetcher:
    def __init__(self, cfg: dict, cache_dir: Path, base_url: str | None = None):
        src = cfg["source"]
        self.cfg = cfg
        self.client = SdmxClient(base_url or src["base_url"], src["agency"],
                                 min_interval=float(os.environ.get("TIVA_MIN_INTERVAL", src["min_request_interval_sec"])),
                                 timeout=src["timeout_sec"], max_retries=src["max_retries"])
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.structures: dict[str, FlowStructure] = {}
        self.measure_flow: dict[str, tuple[str, str]] = {}   # 요청 코드 -> (flow id, 실제 코드)
        self.flows = []

    # ------------------------------------------------------------ discovery
    def discover(self, measures: list[str]):
        src = self.cfg["source"]
        flows = [f for f in self.client.dataflows() if src["flow_keyword"].upper() in f.id.upper()]
        if not flows:
            raise RuntimeError(f"'{src['flow_keyword']}'를 포함한 dataflow가 없습니다")
        editions = [f.edition for f in flows if f.edition]
        if editions:
            latest = max(editions)
            flows = [f for f in flows if f.edition in (latest, None)]
        order = [k.upper() for k in src.get("preferred_flow_order", [])]

        def rank(f):
            fid = f.id.upper()
            return (next((i for i, k in enumerate(order) if k in fid), len(order)), fid)

        flows.sort(key=rank)
        self.flows = flows
        log.info("TiVA dataflow %d개: %s", len(flows), ", ".join(f"{f.id} ({f.name})" for f in flows))

        todo = list(dict.fromkeys(measures))
        for f in flows:
            if not todo:
                break
            try:
                fs = self.client.structure(f)
                assign_roles(fs, self.cfg["dimensions"], self.cfg["codes"]["world"], self.cfg["codes"]["total_activity"])
            except Exception as e:  # 구조가 다른 dataflow는 건너뛴다
                log.warning("구조 확인 실패 %s: %s", f.id, e)
                continue
            self.structures[f.id] = fs
            mdim = fs.roles["measure"]
            found = []
            for m in todo:
                real = fs.resolve_code(mdim, m)
                if real:
                    self.measure_flow[m] = (f.id, real)
                    found.append(m)
            todo = [m for m in todo if m not in found]
            log.info("  %s 차원=%s, 지표 %d개 확인 %s, 기간=%s", f.id, fs.dims, len(found), found, fs.time_range)
        if todo:
            log.warning("어떤 dataflow에서도 찾지 못한 지표: %s", todo)
        return todo

    # ------------------------------------------------------------- download
    def _selection(self, fs: FlowStructure, block: dict, measures: list[str]) -> dict[str, list[str]]:
        codes = self.cfg["codes"]
        acts = self.cfg["activities"]

        def expand(spec, pool):
            out = []
            for s in spec if isinstance(spec, list) else [spec]:
                out += pool.get(s, [s])
            return list(dict.fromkeys(out))

        area_pool = {"economies": codes["economies"], "aggregates": codes["aggregates"]}
        act_pool = {"detail": acts["detail"], "aggregates": acts["aggregates"]}
        r = fs.roles
        sel = {
            "measure": measures,
            "area": [c for c in expand(block["areas"], area_pool) if fs.has_code(r["area"], c)],
            "activity": [c for c in expand(block["activities"], act_pool) if fs.has_code(r["activity"], c)],
        }
        if block["partners"] == "all":
            sel["partner"] = fs.codes(r["partner"])
        else:
            world = next((c for c in [codes["world"], "WLD", "W1", "_T"] if fs.has_code(r["partner"], c)), codes["world"])
            want = expand(block["partners"], {"world": [world]})
            sel["partner"] = [c for c in want if fs.has_code(r["partner"], c)]
        for role, v in sel.items():
            if not v:
                raise RuntimeError(f"{fs.flow.id}: {role} 코드가 비어 있습니다 (설정 코드가 코드목록과 맞지 않음)")
        return sel

    def _cached_download(self, fs: FlowStructure, sel: dict, start: int, end: int) -> pd.DataFrame:
        tag = json.dumps([fs.flow.id, fs.flow.version, sel, start, end], sort_keys=True)
        path = self.cache_dir / (hashlib.sha256(tag.encode()).hexdigest()[:20] + ".parquet")
        if path.exists():
            return pd.read_parquet(path)
        try:
            df = self.client.data(fs, sel, start, end)
        except NoResults:
            df = empty_frame()
        df.to_parquet(path, index=False)
        return df

    def download(self, block_name: str, block: dict, years: list[int] | tuple[int, int]) -> pd.DataFrame:
        src = self.cfg["source"]
        by_flow: dict[str, list[str]] = {}
        for m in block["measures"]:
            if m in self.measure_flow:
                fid, real = self.measure_flow[m]
                by_flow.setdefault(fid, []).append(real)
        spans = [(y, y) for y in years] if isinstance(years, list) else [years]
        frames = []
        for fid, measures in by_flow.items():
            fs = self.structures[fid]
            sel = self._selection(fs, block, measures)

            def key_len(s, fs=fs):
                return len(self.client.build_key(fs, s))

            queue = []
            for (s, e) in spans:
                queue += plan_chunks(sel, s, e, src["max_obs_per_query"], key_len, src["max_key_length"])
            log.info("[%s] %s: 지표 %s, 요청 %d건 예정", block_name, fid, measures, len(queue))
            done = 0
            while queue:
                sel_c, s, e = queue.pop(0)
                try:
                    df = self._cached_download(fs, sel_c, s, e)
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
        if not frames:
            return empty_frame()
        out = pd.concat([f for f in frames if not f.empty] or [empty_frame()], ignore_index=True)
        return tidy(out)


def tidy(df: pd.DataFrame) -> pd.DataFrame:
    """중복 제거와 정렬. 같은 조합에 단위가 여러 개면 첫 번째만 남긴다."""
    if df.empty:
        return df
    df = df.drop_duplicates(subset=["area", "partner", "measure", "activity", "year"], keep="first")
    for c in ("area", "partner", "measure", "activity", "unit"):
        df[c] = df[c].astype(str)
    df = df.sort_values(["measure", "activity", "area", "partner", "year"]).reset_index(drop=True)
    df["value"] = df["value"].astype("float64")
    return df


def write_codelists(fetcher: Fetcher, path: Path):
    out = {"area": {}, "partner": {}, "activity": {}, "measure": {}}
    for fs in fetcher.structures.values():
        for role, dim in fs.roles.items():
            for code, name in fs.codelists.get(dim, {}).items():
                out[role].setdefault(code, name)
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
    blocks = cfg["blocks"]
    all_measures = blocks["country_industry"]["measures"] + blocks["partner"]["measures"]
    missing = fetcher.discover(all_measures)

    signature = {
        "flows": sorted([[f.id, f.version, f.name] for f in fetcher.flows]),
        "config": config_hash(cfg),
    }
    unchanged = old.get("signature") == signature and (out_dir / "tiva_country_industry.parquet").exists()
    if unchanged and not args.force:
        log.info("OECD 판과 설정이 이전 수집과 같아 다시 받지 않습니다 (--force로 강제 수집)")
        gh_output(changed="false")
        return
    if args.check_only:
        log.info("변경 감지: 새 판 또는 설정 변경")
        gh_output(changed="true")
        return

    # 1) 국가 × 산업
    b1 = blocks["country_industry"]
    t = fetcher.structures[fetcher.measure_flow["EXGR"][0]].time_range
    end_year = t[1] or dt.date.today().year
    ci = fetcher.download("country_industry", b1, (b1["start_year"], end_year))
    if ci.empty:
        raise RuntimeError("국가 × 산업 데이터가 비어 있습니다")
    latest = int(ci.loc[ci["measure"] == fetcher.measure_flow["EXGR"][1], "year"].max())
    log.info("최신 연도: %d", latest)

    # 2) 상대국별
    b2 = blocks["partner"]
    years = sorted({y for y in b2["benchmark_years"] if y <= latest} |
                   set(range(latest - b2["recent_years"] + 1, latest + 1)))
    pa = fetcher.download("partner", b2, years)

    changed = False
    for name, df in (("tiva_country_industry", ci), ("tiva_partner", pa)):
        h = frame_hash(df)
        if old.get("hash", {}).get(name) != h or not (out_dir / f"{name}.parquet").exists():
            df.to_parquet(out_dir / f"{name}.parquet", index=False, compression="zstd")
            changed = True
        signature.setdefault("_hash", {})[name] = h
    write_codelists(fetcher, out_dir / "codelists.json")

    manifest = {
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": cfg["source"]["base_url"],
        "agency": cfg["source"]["agency"],
        "edition": max((f.edition for f in fetcher.flows if f.edition), default=None),
        "flows": [{"id": f.id, "version": f.version, "name": f.name} for f in fetcher.flows if f.id in fetcher.structures],
        "measures": {m: {"flow": fid, "code": real} for m, (fid, real) in fetcher.measure_flow.items()},
        "missing_measures": missing,
        "latest_year": latest,
        "partner_years": years,
        "rows": {"tiva_country_industry": len(ci), "tiva_partner": len(pa)},
        "requests": fetcher.client.n_requests,
        "signature": {"flows": signature["flows"], "config": signature["config"]},
        "hash": signature.get("_hash", {}),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    log.info("완료: 국가×산업 %s행, 상대국 %s행, 요청 %d건", f"{len(ci):,}", f"{len(pa):,}", fetcher.client.n_requests)
    gh_output(changed="true" if changed else "false")


if __name__ == "__main__":
    main()
