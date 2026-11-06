"""OECD SDMX API를 흉내 내는 테스트용 로컬 서버.

2026년 11월에 확인한 실제 API 구조를 따른다.
- /public/rest/dataflow/OECD.STI.PIE 는 TiVA dataflow를 외부 참조(isExternalReference, structureURL)로만 보여 준다.
- 실제 구조와 데이터는 /sti-public/rest 에 있다.
- MAINLV, MAINSH 차원 = MEASURE, REF_AREA, ACTIVITY, COUNTERPART_AREA, UNIT_MEASURE, FREQ
- MAINSH 비중은 UNIT_MEASURE로 기준을 구분한다 (PT_EXGR = 총수출 대비 %).
- EXGRVA 차원 = MEASURE, VALUE_ADDED_SOURCE_AREA, VALUE_ADDED_SOURCE_ACTIVITY, EXPORTING_AREA, EXPORTING_ACTIVITY, UNIT_MEASURE, FREQ
값은 내부적으로 일관된 합성 데이터이며 실제 TiVA 수치가 아니다.

    python tests/mock_oecd.py --port 8765 [--too-large 200000] [--fail-first-429]
"""
from __future__ import annotations

import argparse
import io
import itertools
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[1]
CFG = yaml.safe_load(open(ROOT / "config/tiva.yaml", encoding="utf-8"))
GRP = yaml.safe_load(open(ROOT / "config/groups.yaml", encoding="utf-8"))

ECON = CFG["codes"]["economies"]
AGG = ["W", "EU27_2020", "OECD", "ASEAN", "G20", "APEC"]
AREAS = ECON + AGG
DETAIL = CFG["activities"]["detail"]
ACT_AGG = {
    "_T": DETAIL,
    "A": [a for a in DETAIL if a.startswith("A")],
    "B": [a for a in DETAIL if a.startswith("B")],
    "C": [a for a in DETAIL if a.startswith("C")],
    "BTE": [a for a in DETAIL if a[0] in "BCDE"],
    "D_E": ["D", "E"],
    "GTT": [a for a in DETAIL if a[0] in "GHIJKLMNOPQRST"],
    "C26_27": ["C26", "C27"],
}
ACTS = DETAIL + list(ACT_AGG)
YEARS = list(range(1995, 2023))
LV_MEASURES = ["EXGR", "EXGR_FNL", "EXGR_INT", "EXGR_DVA", "EXGR_DDC", "EXGR_IDC", "EXGR_RIM", "EXGR_FVA", "IMGR",
               "IMGR_FNL", "IMGR_INT", "IMGR_DVA", "BALGR", "REII", "PROD", "VALU", "FFD_DVA", "DFD_FVA", "BALVAFD",
               "FD_VA", "CONS_VA", "GFCF_VA"]
SH_MEASURES = ["EXGR_DVA", "EXGR_FVA", "IMGR_DVA", "REII", "FFD_DVA", "FEXGR_DVA", "EXGR_INT_DVA", "EXGR_PSH",
               "EXGR_FVA_PSH", "FEXGR_DVA_PSH"]
SH_UNITS = ["PT_EXGR", "PT_EXGR_T", "PT_EXGR_DVA", "PT_VA"]
MAIN_DIMS = ["MEASURE", "REF_AREA", "ACTIVITY", "COUNTERPART_AREA", "UNIT_MEASURE", "FREQ"]
VA_DIMS = ["MEASURE", "VALUE_ADDED_SOURCE_AREA", "VALUE_ADDED_SOURCE_ACTIVITY", "EXPORTING_AREA", "EXPORTING_ACTIVITY",
           "UNIT_MEASURE", "FREQ"]
PARTNERS = AREAS + ["DXD"]
FLOWS = {
    "DSD_TIVA_MAINLV@DF_MAINLV": ("Trade in Value Added (TiVA) 2025 edition: Principal Indicators, levels", MAIN_DIMS,
                                  {"MEASURE": LV_MEASURES, "REF_AREA": AREAS, "ACTIVITY": ACTS, "COUNTERPART_AREA": PARTNERS,
                                   "UNIT_MEASURE": ["USD"], "FREQ": ["A"]}),
    "DSD_TIVA_MAINSH@DF_MAINSH": ("Trade in Value Added (TiVA) 2025 edition: Principal Indicators, shares", MAIN_DIMS,
                                  {"MEASURE": SH_MEASURES, "REF_AREA": AREAS, "ACTIVITY": ACTS, "COUNTERPART_AREA": PARTNERS,
                                   "UNIT_MEASURE": SH_UNITS, "FREQ": ["A"]}),
    "DSD_TIVA_EXGRVA@DF_EXGRVA": ("Trade in Value Added (TiVA) 2025 edition: Origin of value added in gross exports", VA_DIMS,
                                  {"MEASURE": ["EXGRVA"], "VALUE_ADDED_SOURCE_AREA": AREAS, "VALUE_ADDED_SOURCE_ACTIVITY": ACTS,
                                   "EXPORTING_AREA": AREAS, "EXPORTING_ACTIVITY": ACTS, "UNIT_MEASURE": ["USD"], "FREQ": ["A"]}),
    "DSD_TIVA_FDVA@DF_FDVA": ("Trade in Value Added (TiVA) 2025 edition: Origin of value added in final demand", VA_DIMS, None),
    "DSD_TIVA_MAINLV@DF_MAINLV_2023": ("Trade in Value Added (TiVA) 2023 edition: Principal Indicators, levels", MAIN_DIMS, None),
}

AGG_MEMBERS = {
    "W": ECON,
    "EU27_2020": GRP["regions"]["EU"]["members"],
    "OECD": ECON[:38],
    "ASEAN": ["BRN", "KHM", "IDN", "LAO", "MYS", "MMR", "PHL", "SGP", "THA", "VNM"],
    "G20": ["ARG", "AUS", "BRA", "CAN", "CHN", "FRA", "DEU", "IND", "IDN", "ITA", "JPN", "KOR", "MEX",
            "RUS", "SAU", "ZAF", "TUR", "GBR", "USA"],
    "APEC": ["AUS", "BRN", "CAN", "CHL", "CHN", "HKG", "IDN", "JPN", "KOR", "MYS", "MEX", "NZL", "PER",
             "PHL", "RUS", "SGP", "TWN", "THA", "USA", "VNM"],
}

rng = np.random.default_rng(42)
nE, nD, nY = len(ECON), len(DETAIL), len(YEARS)
size = np.exp(rng.normal(10, 1.3, nE))
w_act = np.exp(rng.normal(0, 1.0, (nE, nD)))
growth = np.exp(0.045 * (np.arange(nY) - 20) + rng.normal(0, 0.03, nY))
EXGR_D = size[:, None, None] * w_act[:, :, None] * growth[None, None, :] / w_act.sum(1)[:, None, None] * 0.25
fva = np.clip(rng.uniform(0.08, 0.45, nE)[:, None, None] + rng.normal(0, 0.06, (1, nD, 1))
              + np.linspace(-0.04, 0.04, nY)[None, None, :], 0.02, 0.8)
fwd = np.clip(rng.uniform(0.10, 0.40, nE)[:, None, None] + rng.normal(0, 0.05, (1, nD, 1)), 0.01, 0.7)


def _agg_acts(arr):
    out = [arr]
    for members in ACT_AGG.values():
        idx = [DETAIL.index(m) for m in members]
        out.append(arr[:, idx, :].sum(1, keepdims=True))
    return np.concatenate(out, axis=1)


def _agg_areas(arr):
    out = [arr]
    for code in AGG:
        idx = [ECON.index(m) for m in AGG_MEMBERS[code]]
        out.append(arr[idx].sum(0, keepdims=True))
    return np.concatenate(out, axis=0)


EXGR = _agg_areas(_agg_acts(EXGR_D))
FVA = _agg_areas(_agg_acts(EXGR_D * fva))
DVAFX = _agg_areas(_agg_acts(EXGR_D * fwd))
DVA = EXGR - FVA
LV = {"EXGR": EXGR, "EXGR_FVA": FVA, "EXGR_DVA": DVA, "IMGR": EXGR * 0.93, "EXGR_INT": EXGR * 0.56,
      "EXGR_FNL": EXGR * 0.44, "VALU": EXGR * 1.8, "PROD": EXGR * 3.1, "FFD_DVA": DVA * 0.72, "DFD_FVA": FVA * 0.8}
SH = {("EXGR_DVA", "PT_EXGR"): DVA / EXGR * 100, ("EXGR_FVA", "PT_EXGR"): FVA / EXGR * 100,
      ("FEXGR_DVA", "PT_EXGR_T"): DVAFX / EXGR * 100,
      ("EXGR_DVA", "PT_VA"): DVA / LV["VALU"] * 100}          # 단위 선택을 시험하기 위한 다른 기준
pw = size[None, :] * np.exp(rng.normal(0, 0.8, (nE, nE)))     # 원천·상대국 가중치 (자기 자신 0)
np.fill_diagonal(pw, 0)
pw = pw / pw.sum(1, keepdims=True)
pw2 = size[None, :] * np.exp(rng.normal(0, 0.8, (nE, nE)))
np.fill_diagonal(pw2, 0)
pw2 = pw2 / pw2.sum(1, keepdims=True)
AI = {a: i for i, a in enumerate(AREAS)}
KI = {k: i for i, k in enumerate(ACTS)}
EI = {e: i for i, e in enumerate(ECON)}


def value(flow, c, yi):
    if flow.endswith("MAINLV"):
        m, a, k, p = c["MEASURE"], c["REF_AREA"], c["ACTIVITY"], c["COUNTERPART_AREA"]
        if m not in LV:
            return None
        ai, ki = AI[a], KI[k]
        if p == "W":
            return LV[m][ai, ki, yi]
        if m in ("EXGR", "FFD_DVA") and a in EI and p in EI and p != a:
            return LV[m][ai, ki, yi] * pw2[EI[a], EI[p]]
        return None
    if flow.endswith("MAINSH"):
        key = (c["MEASURE"], c["UNIT_MEASURE"])
        if key in SH and c["COUNTERPART_AREA"] == "W":
            return SH[key][AI[c["REF_AREA"]], KI[c["ACTIVITY"]], yi]
        return None
    if flow.endswith("EXGRVA"):
        s, sa, e, ea = (c["VALUE_ADDED_SOURCE_AREA"], c["VALUE_ADDED_SOURCE_ACTIVITY"],
                        c["EXPORTING_AREA"], c["EXPORTING_ACTIVITY"])
        if s not in EI:
            return None
        if e == "W":            # 실제 API처럼 세계(W) 항목은 0
            return 0.0
        if e not in EI:
            return None
        if sa == "_T" and ea != "_T":   # 후방: 수출 경제 e(산업 ea)의 총수출에 들어간 원천 s의 부가가치
            ie, ke = EI[e], KI[ea]
            return DVA[ie, ke, yi] if s == e else FVA[ie, ke, yi] * pw[ie, EI[s]]
        if ea == "_T":          # 전방: 원천 s(산업 sa)의 부가가치가 e의 수출에 체화된 크기
            i_s, ks = EI[s], KI[sa]
            return DVA[i_s, ks, yi] * 0.6 if s == e else DVAFX[i_s, ks, yi] * pw2[i_s, EI[e]]
        return 0.01
    return None


STATE = {"too_large": 10**9, "fail_429": False}


def _xml(body):
    return ('<?xml version="1.0" encoding="utf-8"?>'
            '<message:Structure xmlns:message="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message" '
            'xmlns:structure="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/structure" '
            'xmlns:common="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/common"><message:Structures>'
            + body + '</message:Structures></message:Structure>')


def dataflows_xml(host):
    items = "".join(
        f'<structure:Dataflow id="{fid}" agencyID="OECD.STI.PIE" version="1.1" isExternalReference="true" isFinal="true" '
        f'structureURL="http://{host}/sti-public/rest/dataflow/OECD.STI.PIE/{fid}/1.1"><common:Name xml:lang="en">{name}</common:Name></structure:Dataflow>'
        for fid, (name, _, _) in FLOWS.items())
    items += ('<structure:Dataflow id="DSD_STAN@DF_STAN_2025" agencyID="OECD.STI.PIE" version="1.0"><common:Name xml:lang="en">STAN</common:Name>'
              '<structure:Structure><Ref id="DSD_STAN" version="1.0" agencyID="OECD.STI.PIE" package="datastructure" class="DataStructure"/></structure:Structure></structure:Dataflow>')
    return _xml(f"<structure:Dataflows>{items}</structure:Dataflows>")


def structure_xml(fid):
    name, dims, pools = FLOWS[fid]
    dsd = fid.split("@")[0]
    def cl(cid, codes):
        items = "".join(f'<structure:Code id="{c}"><common:Name xml:lang="en">{c} name</common:Name></structure:Code>' for c in codes)
        return f'<structure:Codelist id="{cid}" agencyID="OECD" version="1.0">{items}</structure:Codelist>'
    codelists = "".join(cl(f"CL_{d}", pools[d]) for d in dims)
    dim_xml = "".join(
        f'<structure:Dimension id="{d}" position="{i+1}"><structure:LocalRepresentation><structure:Enumeration>'
        f'<Ref id="CL_{d}" version="1.0" agencyID="OECD" package="codelist" class="Codelist"/>'
        f'</structure:Enumeration></structure:LocalRepresentation></structure:Dimension>' for i, d in enumerate(dims))
    dim_xml += f'<structure:TimeDimension id="TIME_PERIOD" position="{len(dims)+1}"/>'
    kvs = "".join(f'<common:KeyValue id="{d}">' + "".join(f"<common:Value>{c}</common:Value>" for c in pools[d]) + "</common:KeyValue>" for d in dims)
    kvs += ('<common:KeyValue id="TIME_PERIOD"><common:TimeRange><common:StartPeriod isInclusive="true">1995-01-01T00:00:00</common:StartPeriod>'
            '<common:EndPeriod isInclusive="true">2022-12-31T00:00:00</common:EndPeriod></common:TimeRange></common:KeyValue>')
    constraint = (f'<structure:ContentConstraint id="CR_A_{fid}" type="Actual" agencyID="OECD.STI.PIE" version="1.0">'
                  f'<structure:ConstraintAttachment><structure:Dataflow><Ref id="{fid}" version="1.1" agencyID="OECD.STI.PIE"/></structure:Dataflow></structure:ConstraintAttachment>'
                  f'<structure:CubeRegion include="true">{kvs}</structure:CubeRegion></structure:ContentConstraint>')
    return _xml(
        f'<structure:Codelists>{codelists}</structure:Codelists><structure:Constraints>{constraint}</structure:Constraints>'
        f'<structure:Dataflows><structure:Dataflow id="{fid}" agencyID="OECD.STI.PIE" version="1.1"><common:Name xml:lang="en">{name}</common:Name>'
        f'<structure:Structure><Ref id="{dsd}" version="1.1" agencyID="OECD.STI.PIE" package="datastructure" class="DataStructure"/></structure:Structure></structure:Dataflow></structure:Dataflows>'
        f'<structure:DataStructures><structure:DataStructure id="{dsd}" agencyID="OECD.STI.PIE" version="1.1"><common:Name xml:lang="en">{dsd}</common:Name>'
        f'<structure:DataStructureComponents><structure:DimensionList id="DimensionDescriptor">{dim_xml}</structure:DimensionList></structure:DataStructureComponents>'
        '</structure:DataStructure></structure:DataStructures>')


def data_csv(fid, key, start, end):
    name, dims, pools = FLOWS[fid]
    parts = key.split(".")
    if len(parts) != len(dims):
        return 400, "Semantic error: wrong number of dimensions in key"
    sel = [[c for c in (p.split("+") if p else pools[d]) if c in pools[d]] for d, p in zip(dims, parts)]
    years = [y for y in YEARS if start <= y <= end]
    n = int(np.prod([len(s) for s in sel])) * len(years)
    if n > STATE["too_large"]:
        return 413, "Request Entity Too Large: response exceeds maximum"
    buf = io.StringIO()
    buf.write(",".join(["DATAFLOW"] + dims + ["TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"]) + "\n")
    rows = 0
    tag = f"OECD.STI.PIE:{fid}(1.1)"
    for combo in itertools.product(*sel):
        c = dict(zip(dims, combo))
        for y in years:
            v = value(fid, c, YEARS.index(y))
            if v is None or not np.isfinite(v):
                continue
            mult = 0 if c["UNIT_MEASURE"].startswith("PT") else 6
            buf.write(",".join([tag, *combo, str(y), f"{v:.3f}", str(mult)]) + "\n")
            rows += 1
    if not rows:
        return 404, "No Results Found"
    return 200, buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[mock] " + fmt % args + "\n")

    def _send(self, code, body, ctype="text/plain"):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if code == 429:
            self.send_header("Retry-After", "1")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        host = self.headers.get("Host", "127.0.0.1")
        if u.path.rstrip("/") == "/public/rest/dataflow/OECD.STI.PIE":
            return self._send(200, dataflows_xml(host), "application/vnd.sdmx.structure+xml; version=2.1")
        m = re.match(r"^/public/rest/dataflow/OECD\.STI\.PIE/([^/]+)/([^/]+)$", u.path)
        if m:   # 기본 주소에서는 외부 참조만 돌려준다 (DataStructure 없음)
            return self._send(200, dataflows_xml(host), "application/vnd.sdmx.structure+xml; version=2.1")
        m = re.match(r"^/sti-public/rest/dataflow/OECD\.STI\.PIE/([^/]+)/([^/]+)$", u.path)
        if m:
            fid = m.group(1)
            if fid not in FLOWS or FLOWS[fid][2] is None:
                return self._send(404, "No Results Found")
            return self._send(200, structure_xml(fid), "application/vnd.sdmx.structure+xml; version=2.1")
        m = re.match(r"^/sti-public/rest/data/OECD\.STI\.PIE,([^,]+),([^/]+)/(.*)$", u.path)
        if m:
            if STATE["fail_429"]:
                STATE["fail_429"] = False
                return self._send(429, "Too Many Requests")
            fid = m.group(1)
            if fid not in FLOWS or FLOWS[fid][2] is None:
                return self._send(404, "No Results Found")
            code, body = data_csv(fid, m.group(3), int(q.get("startPeriod", 1995)), int(q.get("endPeriod", 2022)))
            return self._send(code, body, "application/vnd.sdmx.data+csv; charset=utf-8" if code == 200 else "text/plain")
        return self._send(404, "unknown path")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--too-large", type=int, default=10**9)
    ap.add_argument("--fail-first-429", action="store_true")
    a = ap.parse_args()
    STATE["too_large"] = a.too_large
    STATE["fail_429"] = a.fail_first_429
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print(f"mock OECD SDMX on http://127.0.0.1:{a.port}/public/rest", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
