"""OECD SDMX REST API 클라이언트.

- dataflow 목록과 구조(DSD, 코드목록, 내용 제약)를 읽어 차원 순서와 사용 가능한 코드를 확인한다.
- 데이터는 SDMX-CSV로 받아 표준 열(area, partner, measure, activity, year, value)로 정리한다.
- 요청 간격 유지, 429/5xx 재시도, 응답이 너무 클 때의 자동 분할을 지원한다.
"""
from __future__ import annotations

import csv
import io
import logging
import math
import re
import tempfile
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd
import requests

log = logging.getLogger("tiva.sdmx")

STRUCT_ACCEPT = "application/vnd.sdmx.structure+xml;version=2.1"
CSV_ACCEPT = "application/vnd.sdmx.data+csv;version=1.0.0, text/csv;q=0.9, */*;q=0.1"
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"

ROLES = ("area", "partner", "measure", "activity")


class NoResults(Exception):
    """조건에 맞는 관측치가 없을 때 (HTTP 404 NoResultsFound)."""


class TooLarge(Exception):
    """응답이 너무 커서 서버가 거절했을 때. 요청을 나눠서 다시 보낸다."""


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _children(el, name):
    return [c for c in el if _local(c.tag) == name]


def _name(el, lang="en") -> str:
    names = _children(el, "Name")
    for n in names:
        if n.get(XML_LANG) == lang:
            return (n.text or "").strip()
    return (names[0].text or "").strip() if names else ""


@dataclass
class Flow:
    id: str
    version: str
    name: str
    agency: str
    dsd_id: str | None = None
    dsd_agency: str | None = None
    dsd_version: str | None = None
    external: bool = False
    structure_url: str | None = None   # 외부 참조 dataflow의 실제 위치 (OECD TiVA는 /sti-public/rest)

    @property
    def service_base(self) -> str | None:
        """외부 참조이면 실제 REST 기본 주소를 돌려준다."""
        u = self.structure_url
        if not u:
            return None
        for marker in ("/dataflow/", "/datastructure/"):
            if marker in u:
                return u.split(marker, 1)[0]
        return u.rstrip("/")

    @property
    def edition(self) -> int | None:
        m = re.search(r"(19|20)\d{2}(?=\s*edition)", self.name, flags=re.I)
        return int(m.group(0)) if m else None


@dataclass
class FlowStructure:
    flow: Flow
    dims: list[str]                               # 키 순서대로의 차원 id (시간 제외)
    codelists: dict[str, dict[str, str]]          # 차원 id -> {코드: 영문명}
    allowed: dict[str, set[str]] = field(default_factory=dict)  # 내용 제약(Actual/Allowed)
    time_range: tuple[int | None, int | None] = (None, None)
    roles: dict[str, str] = field(default_factory=dict)          # 역할 -> 차원 id

    def codes(self, dim: str) -> list[str]:
        cl = self.codelists.get(dim, {})
        if self.allowed.get(dim):
            allowed = self.allowed[dim]
            ordered = [c for c in cl if c in allowed]
            # 코드목록에 없지만 제약에 있는 코드도 포함
            ordered += sorted(allowed - set(ordered))
            return ordered
        return list(cl)

    def has_code(self, dim: str, code: str) -> bool:
        return code in set(self.codes(dim))

    def resolve_code(self, dim: str, code: str) -> str | None:
        """대소문자 차이를 허용해 실제 코드로 맞춘다 (예: DEXFVAPSH -> DEXFVApSH)."""
        codes = self.codes(dim)
        if code in codes:
            return code
        low = {c.lower(): c for c in codes}
        return low.get(code.lower())


def parse_dataflows(xml_bytes: bytes, agency: str) -> list[Flow]:
    root = ET.fromstring(xml_bytes)
    flows = []
    for el in root.iter():
        if _local(el.tag) != "Dataflow" or not el.get("id"):
            continue
        ref = None
        for s in _children(el, "Structure"):
            ref = next((x for x in s.iter() if _local(x.tag) == "Ref"), None)
        url = el.get("structureURL") or el.get("serviceURL")
        if not url:  # 속성 이름이 다른 경우 대비
            url = next((v for k, v in el.attrib.items() if isinstance(v, str) and v.startswith("http")), None)
        flows.append(Flow(
            id=el.get("id"),
            version=el.get("version", "latest"),
            name=_name(el),
            agency=el.get("agencyID", agency),
            dsd_id=ref.get("id") if ref is not None else None,
            dsd_agency=ref.get("agencyID") if ref is not None else None,
            dsd_version=ref.get("version") if ref is not None else None,
            external=(el.get("isExternalReference", "false").lower() == "true"),
            structure_url=url,
        ))
    return flows


def _year(text: str | None) -> int | None:
    if not text:
        return None
    m = re.match(r"\s*(\d{4})", text)
    return int(m.group(1)) if m else None


def parse_structure(xml_bytes: bytes, flow: Flow) -> FlowStructure:
    root = ET.fromstring(xml_bytes)

    codelists: dict[tuple[str | None, str], dict[str, str]] = {}
    for el in root.iter():
        if _local(el.tag) == "Codelist" and el.get("id"):
            codes = {c.get("id"): _name(c) for c in _children(el, "Code") if c.get("id")}
            codelists[(el.get("agencyID"), el.get("id"))] = codes
            codelists.setdefault((None, el.get("id")), codes)

    dsds = [el for el in root.iter() if _local(el.tag) == "DataStructure" and el.get("id")]
    if not dsds:
        raise RuntimeError(f"{flow.id}: 응답에 DataStructure가 없습니다")
    dsd = next((d for d in dsds if d.get("id") == flow.dsd_id), dsds[0])

    dims: list[tuple[int, str, dict]] = []
    for el in dsd.iter():
        if _local(el.tag) != "Dimension" or not el.get("id"):
            continue
        cl: dict[str, str] = {}
        for rep in el.iter():
            if _local(rep.tag) == "Enumeration":
                ref = next((x for x in rep.iter() if _local(x.tag) == "Ref"), None)
                if ref is not None:
                    cl = codelists.get((ref.get("agencyID"), ref.get("id"))) or codelists.get((None, ref.get("id")), {})
        pos = int(el.get("position") or len(dims) + 1)
        dims.append((pos, el.get("id"), cl))
    dims.sort(key=lambda t: t[0])

    allowed: dict[str, set[str]] = {}
    time_range: tuple[int | None, int | None] = (None, None)
    constraints = []
    for el in root.iter():
        if _local(el.tag) != "ContentConstraint":
            continue
        attached = {x.get("id") for x in el.iter() if _local(x.tag) == "Ref"}
        if flow.id in attached or (flow.dsd_id and flow.dsd_id in attached):
            constraints.append(el)
    # Actual 제약을 우선 사용
    constraints.sort(key=lambda c: 0 if (c.get("type") or "").lower() == "actual" else 1)
    if constraints:
        c = constraints[0]
        for region in c.iter():
            if _local(region.tag) != "CubeRegion" or region.get("include", "true") != "true":
                continue
            for kv in region:
                if _local(kv.tag) not in ("KeyValue", "AttributeValue"):
                    continue
                kid = kv.get("id")
                vals = {(v.text or "").strip() for v in kv if _local(v.tag) == "Value"}
                if vals and kid:
                    allowed.setdefault(kid, set()).update(vals)
                for tr in kv:
                    if _local(tr.tag) == "TimeRange":
                        start = next((_year(x.text) for x in tr if _local(x.tag) in ("StartPeriod", "AfterPeriod")), None)
                        end = next((_year(x.text) for x in tr if _local(x.tag) in ("EndPeriod", "BeforePeriod")), None)
                        time_range = (start, end)

    return FlowStructure(
        flow=flow,
        dims=[d[1] for d in dims],
        codelists={d[1]: d[2] for d in dims},
        allowed=allowed,
        time_range=time_range,
    )


def assign_roles(fs: FlowStructure, candidates: dict[str, list[str]], world_code="W", total_code="_T") -> dict[str, str]:
    """차원 id를 역할(area, partner, measure, activity)에 연결한다."""
    roles: dict[str, str] = {}
    for role in ROLES:
        for cand in candidates.get(role, []):
            if cand in fs.dims and cand not in roles.values():
                roles[role] = cand
                break
    # 이름으로 못 찾은 경우 코드 내용으로 추정
    remaining = [d for d in fs.dims if d not in roles.values()]
    if "area" not in roles or "partner" not in roles:
        area_like = [d for d in remaining if {"KOR", "USA"} <= set(fs.codelists.get(d, {}))]
        for role in ("area", "partner"):
            if role not in roles and area_like:
                roles[role] = area_like.pop(0)
    if "activity" not in roles:
        act = [d for d in remaining if total_code in fs.codelists.get(d, {}) and "C26" in fs.codelists.get(d, {})]
        if act:
            roles["activity"] = act[0]
    if "measure" not in roles:
        mea = [d for d in remaining if "EXGR" in fs.codelists.get(d, {})]
        if mea:
            roles["measure"] = mea[0]
    missing = [r for r in ROLES if r not in roles]
    if missing:
        raise RuntimeError(f"{fs.flow.id}: 차원 역할을 찾지 못했습니다 {missing} (차원: {fs.dims})")
    fs.roles = roles
    return roles


class SdmxClient:
    def __init__(self, base_url: str, agency: str, min_interval: float = 6.0, timeout: int = 600,
                 max_retries: int = 10, user_agent: str = "oecd-tiva-gvc-dashboard/1.0 (GitHub Actions)"):
        self.base = base_url.rstrip("/")
        self.agency = agency
        self.min_interval = min_interval
        self.timeout = timeout
        self.max_retries = max_retries
        self.session = requests.Session()
        self.session.headers["User-Agent"] = user_agent
        self._last = 0.0
        self.n_requests = 0

    # ------------------------------------------------------------------ HTTP
    def _get(self, url: str, params: dict | None = None, accept: str | None = None, stream: bool = False,
             max_5xx: int | None = None):
        """GET with pacing. 429은 Retry-After를 따라 재시도한다.
        max_5xx를 주면 서버 오류(502/503/504)가 그 횟수만큼 이어질 때 응답을 그대로 돌려준다."""
        last_err = None
        n5xx = 0
        for attempt in range(self.max_retries):
            wait = self.min_interval - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            self.n_requests += 1
            try:
                r = self.session.get(url, params=params, timeout=self.timeout, stream=stream,
                                     headers={"Accept": accept} if accept else None)
            except (requests.ConnectionError, requests.Timeout) as e:
                last_err = e
                delay = min(600, 15 * 2 ** attempt)
                log.warning("연결 오류 (%s), %ss 후 재시도 %d/%d", e.__class__.__name__, delay, attempt + 1, self.max_retries)
                time.sleep(delay)
                continue
            if r.status_code in (502, 503, 504):
                n5xx += 1
                if max_5xx is not None and n5xx >= max_5xx:
                    return r
            if r.status_code in (429, 502, 503, 504):
                ra = r.headers.get("Retry-After", "")
                delay = int(ra) if ra.isdigit() else min(900, 30 * 2 ** attempt)
                log.warning("HTTP %s, %ss 후 재시도 %d/%d", r.status_code, delay, attempt + 1, self.max_retries)
                r.close()
                time.sleep(delay)
                last_err = RuntimeError(f"HTTP {r.status_code}")
                continue
            return r
        raise RuntimeError(f"재시도 한도 초과: {url} ({last_err})")

    # ------------------------------------------------------------- structure
    def dataflows(self) -> list[Flow]:
        last = None
        for path in (f"dataflow/{self.agency}", f"dataflow/{self.agency}/all/latest", "dataflow/all/all/latest"):
            r = self._get(f"{self.base}/{path}", accept=STRUCT_ACCEPT)
            if r.ok:
                flows = [f for f in parse_dataflows(r.content, self.agency) if f.agency == self.agency]
                if flows:
                    return flows
            last = r
            log.info("dataflow 목록 %s -> HTTP %s, 다른 경로로 재시도", path, r.status_code)
        last.raise_for_status()
        return []

    def base_for(self, flow: Flow) -> str:
        return flow.service_base or self.base

    def structure(self, flow: Flow) -> FlowStructure:
        url = f"{self.base_for(flow)}/dataflow/{flow.agency}/{flow.id}/{flow.version}"
        last_err = None
        for params in ({"references": "all", "detail": "referencepartial"}, {"references": "all"},
                       {"references": "descendants"}):
            r = self._get(url, params=params, accept=STRUCT_ACCEPT)
            if not r.ok:
                last_err = RuntimeError(f"HTTP {r.status_code}")
                log.info("구조 조회 %s %s -> HTTP %s, 다른 옵션으로 재시도", flow.id, params, r.status_code)
                continue
            try:
                fs = parse_structure(r.content, flow)
            except RuntimeError as e:   # DataStructure가 없는 응답 (예: 외부 참조만 담긴 응답)
                last_err = e
                log.info("구조 조회 %s %s -> %s, 다른 옵션으로 재시도", flow.id, params, e)
                continue
            if fs.dims:
                return fs
        raise RuntimeError(f"{flow.id}: 구조를 해석하지 못했습니다 ({last_err}, 주소 {url})")

    # ------------------------------------------------------------------ data
    @staticmethod
    def build_key(fs: FlowStructure, selection: dict[str, list[str]]) -> str:
        """selection은 차원 id -> 코드 목록. 없는 차원은 전체(빈칸)."""
        return ".".join("+".join(selection.get(d) or []) for d in fs.dims)

    def data(self, fs: FlowStructure, selection: dict[str, list[str]], start: int, end: int) -> pd.DataFrame:
        key = self.build_key(fs, selection)
        url = f"{self.base_for(fs.flow)}/data/{fs.flow.agency},{fs.flow.id},{fs.flow.version}/{key}"
        params = {"startPeriod": str(start), "endPeriod": str(end),
                  "dimensionAtObservation": "AllDimensions", "format": "csvfile"}
        r = self._get(url, params=params, accept=CSV_ACCEPT, stream=True, max_5xx=3)
        if r.status_code in (400, 406) and "format" in r.text[:2000].lower():
            # format 매개변수를 지원하지 않는 경우 Accept 헤더만으로 다시 요청
            r.close()
            params.pop("format")
            r = self._get(url, params=params, accept=CSV_ACCEPT, stream=True, max_5xx=3)
        if r.status_code == 404:
            r.close()
            raise NoResults(key)
        # 413/414, 크기 관련 400/500, 반복된 시간 초과(502~504)는 요청을 나눠서 다시 시도한다
        if r.status_code in (413, 414, 502, 503, 504) or (r.status_code in (400, 500) and _looks_too_large(r)):
            r.close()
            raise TooLarge(f"HTTP {r.status_code}")
        if not r.ok:
            raise RuntimeError(f"HTTP {r.status_code} {r.text[:300]} ({r.url})")
        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as tmp:
            for chunk in r.iter_content(chunk_size=1 << 20):
                tmp.write(chunk)
            path = Path(tmp.name)
        try:
            return read_sdmx_csv(path, fs.dims)
        finally:
            path.unlink(missing_ok=True)


def _looks_too_large(r) -> bool:
    try:
        text = r.text[:2000].lower()
    except Exception:
        return False
    return any(w in text for w in ("too large", "too many", "exceed", "limit", "maximum"))


SKIP_DIMS = {"FREQ"}


def out_columns(dims: list[str]) -> list[str]:
    return [d for d in dims if d not in SKIP_DIMS] + ["year", "value", "unit_mult"]


def read_sdmx_csv(path: Path, dims: list[str]) -> pd.DataFrame:
    """SDMX-CSV(1.0, 2.0, 라벨 포함 형식)를 차원 id 열 + year, value, unit_mult로 정리한다."""
    with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
        head = fh.read(4096)
    if not head.strip():
        return empty_frame(dims)
    if head.lstrip().startswith("<"):
        raise RuntimeError("CSV 대신 XML 응답을 받았습니다: " + head[:300])
    header = next(csv.reader(io.StringIO(head.splitlines()[0])))
    keep = [d for d in dims if d not in SKIP_DIMS]
    for need in keep + ["TIME_PERIOD", "OBS_VALUE"]:
        if need not in header:
            raise RuntimeError(f"CSV에 필요한 열이 없습니다: {need} (열: {header[:20]})")
    usecols = keep + ["TIME_PERIOD", "OBS_VALUE"] + (["UNIT_MULT"] if "UNIT_MULT" in header else [])
    df = pd.read_csv(path, usecols=usecols, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    out = pd.DataFrame({d: _code_only(df[d]) for d in keep})
    out["year"] = pd.to_numeric(df["TIME_PERIOD"].str[:4], errors="coerce")
    out["value"] = pd.to_numeric(df["OBS_VALUE"], errors="coerce")
    out["unit_mult"] = pd.to_numeric(df["UNIT_MULT"], errors="coerce") if "UNIT_MULT" in df else math.nan
    out = out.dropna(subset=["year", "value"])
    out["year"] = out["year"].astype("int16")
    return out[out_columns(dims)].reset_index(drop=True)


def _code_only(s: pd.Series) -> pd.Series:
    s = s.astype(str)
    if s.str.contains(": ", regex=False).any():
        s = s.str.split(": ", n=1).str[0]
    return s.str.strip()


def empty_frame(dims: list[str]) -> pd.DataFrame:
    cols = out_columns(dims)
    return pd.DataFrame({c: pd.Series(dtype="float64" if c in ("value", "unit_mult") else
                                      ("int16" if c == "year" else "object")) for c in cols})


# ----------------------------------------------------------------- planning
def estimate_obs(selection: dict[str, list[str]], start: int, end: int) -> int:
    n = end - start + 1
    for codes in selection.values():
        n *= max(1, len(codes))
    return n


def plan_chunks(selection: dict[str, list[str]], start: int, end: int, max_obs: int,
                key_len, max_key_len: int) -> list[tuple[dict, int, int]]:
    """관측치 추정값과 URL 키 길이가 상한 이하가 되도록 요청을 나눈다."""
    out = []
    stack = [(selection, start, end)]
    while stack:
        sel, s, e = stack.pop()
        if estimate_obs(sel, s, e) <= max_obs and key_len(sel) <= max_key_len:
            out.append((sel, s, e))
            continue
        halves = split_once(sel, s, e)
        if halves is None:
            out.append((sel, s, e))
        else:
            stack.extend(reversed(halves))
    return out


def split_once(sel, s, e):
    """코드 수가 가장 많은 차원을 반으로 나누고, 모두 한 개면 기간을 나눈다."""
    dims = sorted((d for d in sel if len(sel[d] or []) > 1), key=lambda d: -len(sel[d]))
    if dims:
        d = dims[0]
        codes = sel[d]
        mid = len(codes) // 2
        a, b = dict(sel), dict(sel)
        a[d], b[d] = codes[:mid], codes[mid:]
        return [(a, s, e), (b, s, e)]
    if e > s:
        mid = (s + e) // 2
        return [(sel, s, mid), (sel, mid + 1, e)]
    return None
