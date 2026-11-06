"""OECD SDMX API를 흉내 내는 테스트용 로컬 서버.

수집·가공 코드를 실제 OECD 서버 없이 검증하기 위한 것이다. 값은 내부적으로 일관된 합성 데이터이며
실제 TiVA 수치가 아니다. 대시보드나 분석에 사용하지 않는다.

    python tests/mock_oecd.py --port 8765 [--too-large 200000] [--fail-first-429]
"""
from __future__ import annotations

import argparse
import io
import itertools
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import pandas as pd
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
LEVELS = ["EXGR", "IMGR", "EXGR_INT", "EXGR_FNL", "EXGR_DVA", "EXGR_FVA", "VALU", "PROD", "FFD_DVA", "DFD_FVA"]
SHARES = ["EXGR_DVASH", "EXGR_FVASH", "EXGR_DVAFXSH", "DEXFVApSH", "FEXDVApSH", "EXGR_INTDVASH"]
FLOWS = {
    "DSD_TIVA_MAINLV@DF_MAINLV": ("DSD_TIVA_MAINLV", "Trade in Value Added (TiVA) 2025 edition: Principal Indicators, levels", LEVELS),
    "DSD_TIVA_MAINSH@DF_MAINSH": ("DSD_TIVA_MAINSH", "Trade in Value Added (TiVA) 2025 edition: Principal Indicators, shares", SHARES),
    "DSD_TIVA_MAINLV@DF_MAINLV_2023": ("DSD_TIVA_MAINLV", "Trade in Value Added (TiVA) 2023 edition: Principal Indicators, levels", LEVELS),
}
# 차원 순서를 일부러 섞어 역할 매핑을 시험한다
DIMS = ["REF_AREA", "MEASURE", "ACTIVITY", "COUNTERPART_AREA", "UNIT_MEASURE"]

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
size = np.exp(rng.normal(10, 1.3, nE))            # 경제 규모
w_act = np.exp(rng.normal(0, 1.0, (nE, nD)))      # 국가별 산업 구성
growth = np.exp(0.045 * (np.arange(nY) - 20) + rng.normal(0, 0.03, nY))
EXGR_D = size[:, None, None] * w_act[:, :, None] * growth[None, None, :] / w_act.sum(1)[:, None, None] * 0.25
fva = np.clip(rng.uniform(0.08, 0.45, nE)[:, None, None] + rng.normal(0, 0.06, (1, nD, 1))
              + np.linspace(-0.04, 0.04, nY)[None, None, :], 0.02, 0.8)
fwd = np.clip(rng.uniform(0.10, 0.40, nE)[:, None, None] + rng.normal(0, 0.05, (1, nD, 1)), 0.01, 0.7)
FVA_D = EXGR_D * fva
DVAFX_D = EXGR_D * fwd


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
FVA = _agg_areas(_agg_acts(FVA_D))
DVAFX = _agg_areas(_agg_acts(DVAFX_D))
DVA = EXGR - FVA
BLOCK = {
    "EXGR": EXGR, "EXGR_FVA": FVA, "EXGR_DVA": DVA, "IMGR": EXGR * 0.93, "EXGR_INT": EXGR * 0.56,
    "EXGR_FNL": EXGR * 0.44, "VALU": EXGR * 1.8, "PROD": EXGR * 3.1, "FFD_DVA": DVA * 0.72, "DFD_FVA": FVA * 0.8,
    "EXGR_DVASH": DVA / EXGR * 100, "EXGR_FVASH": FVA / EXGR * 100, "EXGR_DVAFXSH": DVAFX / EXGR * 100,
    "EXGR_INTDVASH": DVA * 0.5 / EXGR * 100,
}
# 상대국 가중치 (자기 자신 제외), 규모가 큰 상대국일수록 비중이 크다
pw = size[None, :] * np.exp(rng.normal(0, 0.8, (nE, nE)))
np.fill_diagonal(pw, 0)
pw = pw / pw.sum(1, keepdims=True)
PARTNERS = ECON + AGG + ["DXD"]


def partner_value(measure, area_i, act_i, year_i):
    """area(개별 경제 또는 집계) × 모든 상대국 벡터."""
    if area_i >= nE:
        return None
    base_share = {"DEXFVApSH": BLOCK["EXGR_FVASH"], "FEXDVApSH": BLOCK["EXGR_DVAFXSH"]}.get(measure)
    if base_share is not None:
        total = base_share[area_i, act_i, year_i]
    else:
        total = BLOCK[measure][area_i, act_i, year_i]
    vec = total * pw[area_i]
    agg = [vec[[ECON.index(m) for m in AGG_MEMBERS[c]]].sum() if c != "W" else total for c in AGG]
    return np.concatenate([vec, agg, [np.nan]])


def unit_of(m):
    return "PT_B1GQ" if m.endswith("SH") else "USD_EXC"


STATE = {"too_large": 10**9, "fail_429": False, "requests": 0}


def structure_xml(flow_id):
    dsd_id, name, measures = FLOWS[flow_id]
    def cl(cid, codes):
        items = "".join(f'<str:Code id="{c}"><com:Name xml:lang="en">{c} name</com:Name></str:Code>' for c in codes)
        return f'<str:Codelist id="{cid}" agencyID="OECD" version="1.0">{items}</str:Codelist>'
    codelists = (cl("CL_AREA", AREAS + ["DXD"]) + cl("CL_MEASURE_TIVA", LEVELS + SHARES + ["EXGR_BSCI"])
                 + cl("CL_ACTIVITY_ISIC4", ACTS) + cl("CL_UNIT_MEASURE", ["USD_EXC", "PT_B1GQ"]))
    clmap = {"REF_AREA": "CL_AREA", "COUNTERPART_AREA": "CL_AREA", "MEASURE": "CL_MEASURE_TIVA",
             "ACTIVITY": "CL_ACTIVITY_ISIC4", "UNIT_MEASURE": "CL_UNIT_MEASURE"}
    dims = "".join(
        f'<str:Dimension id="{d}" position="{i+1}"><str:LocalRepresentation><str:Enumeration>'
        f'<Ref id="{clmap[d]}" version="1.0" agencyID="OECD" package="codelist" class="Codelist"/>'
        f'</str:Enumeration></str:LocalRepresentation></str:Dimension>' for i, d in enumerate(DIMS))
    dims += f'<str:TimeDimension id="TIME_PERIOD" position="{len(DIMS)+1}"/>'
    vals = "".join(f"<com:Value>{m}</com:Value>" for m in measures)
    constraint = (
        f'<str:ContentConstraint id="CR_A_{flow_id}" type="Actual" agencyID="OECD.STI.PIE" version="1.0">'
        f'<str:ConstraintAttachment><str:Dataflow><Ref id="{flow_id}" version="1.0" agencyID="OECD.STI.PIE"/></str:Dataflow></str:ConstraintAttachment>'
        f'<str:CubeRegion include="true"><com:KeyValue id="MEASURE">{vals}</com:KeyValue>'
        f'<com:KeyValue id="TIME_PERIOD"><com:TimeRange><com:StartPeriod isInclusive="true">1995-01-01T00:00:00</com:StartPeriod>'
        f'<com:EndPeriod isInclusive="true">2022-12-31T00:00:00</com:EndPeriod></com:TimeRange></com:KeyValue></str:CubeRegion>'
        f'</str:ContentConstraint>')
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<message:Structure xmlns:message="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message" '
        'xmlns:str="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/structure" '
        'xmlns:com="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/common"><message:Structures>'
        f'<str:Codelists>{codelists}</str:Codelists>'
        f'<str:Constraints>{constraint}</str:Constraints>'
        f'<str:Dataflows><str:Dataflow id="{flow_id}" agencyID="OECD.STI.PIE" version="1.0"><com:Name xml:lang="en">{name}</com:Name>'
        f'<str:Structure><Ref id="{dsd_id}" version="1.0" agencyID="OECD.STI.PIE" package="datastructure" class="DataStructure"/></str:Structure></str:Dataflow></str:Dataflows>'
        f'<str:DataStructures><str:DataStructure id="{dsd_id}" agencyID="OECD.STI.PIE" version="1.0"><com:Name xml:lang="en">{dsd_id}</com:Name>'
        f'<str:DataStructureComponents><str:DimensionList id="DimensionDescriptor">{dims}</str:DimensionList></str:DataStructureComponents>'
        '</str:DataStructure></str:DataStructures></message:Structures></message:Structure>')


def dataflows_xml():
    items = "".join(
        f'<str:Dataflow id="{fid}" agencyID="OECD.STI.PIE" version="1.0"><com:Name xml:lang="en">{name}</com:Name>'
        f'<str:Structure><Ref id="{dsd}" version="1.0" agencyID="OECD.STI.PIE" package="datastructure" class="DataStructure"/></str:Structure></str:Dataflow>'
        for fid, (dsd, name, _) in FLOWS.items())
    items += ('<str:Dataflow id="DSD_STAN@DF_STAN_2025" agencyID="OECD.STI.PIE" version="1.0"><com:Name xml:lang="en">STAN</com:Name>'
              '<str:Structure><Ref id="DSD_STAN" version="1.0" agencyID="OECD.STI.PIE" package="datastructure" class="DataStructure"/></str:Structure></str:Dataflow>')
    return ('<?xml version="1.0" encoding="utf-8"?>'
            '<message:Structure xmlns:message="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message" '
            'xmlns:str="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/structure" '
            'xmlns:com="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/common"><message:Structures>'
            f'<str:Dataflows>{items}</str:Dataflows></message:Structures></message:Structure>')


def data_csv(flow_id, key, start, end):
    dsd_id, _, measures = FLOWS[flow_id]
    parts = key.split(".")
    if len(parts) != len(DIMS):
        return 400, "Semantic error: key length"
    sel = {}
    pools = {"REF_AREA": AREAS, "MEASURE": measures, "ACTIVITY": ACTS, "COUNTERPART_AREA": PARTNERS,
             "UNIT_MEASURE": ["USD_EXC", "PT_B1GQ"]}
    for d, p in zip(DIMS, parts):
        sel[d] = [c for c in (p.split("+") if p else pools[d]) if c in pools[d]]
    years = [y for y in YEARS if start <= y <= end]
    n = len(sel["REF_AREA"]) * len(sel["MEASURE"]) * len(sel["ACTIVITY"]) * len(sel["COUNTERPART_AREA"]) * len(years)
    if n > STATE["too_large"]:
        return 413, "Request Entity Too Large: response exceeds maximum"
    rows = []
    for m in sel["MEASURE"]:
        u = unit_of(m)
        if sel["UNIT_MEASURE"] and u not in sel["UNIT_MEASURE"]:
            continue
        for a in sel["REF_AREA"]:
            ai = AREAS.index(a)
            for act in sel["ACTIVITY"]:
                ki = ACTS.index(act)
                for y in years:
                    yi = YEARS.index(y)
                    if m in BLOCK:
                        if "W" in sel["COUNTERPART_AREA"]:
                            rows.append((a, m, act, "W", u, y, BLOCK[m][ai, ki, yi]))
                        if m in ("EXGR", "FFD_DVA") and len(sel["COUNTERPART_AREA"]) > 1:
                            vec = partner_value(m, ai, ki, yi)
                            if vec is not None:
                                for p in sel["COUNTERPART_AREA"]:
                                    if p != "W":
                                        v = vec[PARTNERS.index(p)]
                                        if not np.isnan(v):
                                            rows.append((a, m, act, p, u, y, v))
                    elif m in ("DEXFVApSH", "FEXDVApSH"):
                        vec = partner_value(m, ai, ki, yi)
                        if vec is None:
                            continue
                        for p in sel["COUNTERPART_AREA"]:
                            v = vec[PARTNERS.index(p)]
                            if not np.isnan(v):
                                rows.append((a, m, act, p, u, y, v))
    if not rows:
        return 404, "NoResultsFound"
    df = pd.DataFrame(rows, columns=["REF_AREA", "MEASURE", "ACTIVITY", "COUNTERPART_AREA", "UNIT_MEASURE",
                                     "TIME_PERIOD", "OBS_VALUE"])
    df.insert(0, "ACTION", "I")
    df.insert(0, "STRUCTURE_ID", f"OECD.STI.PIE:{flow_id}(1.0)")
    df.insert(0, "STRUCTURE", "DATAFLOW")
    df["OBS_VALUE"] = df["OBS_VALUE"].round(4)
    df["UNIT_MULT"] = np.where(df["UNIT_MEASURE"] == "USD_EXC", 6, 0)
    df["OBS_STATUS"] = "A"
    buf = io.StringIO()
    df.to_csv(buf, index=False)
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
        STATE["requests"] += 1
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        path = u.path.replace("/public/rest", "")
        if path.rstrip("/") == "/dataflow/OECD.STI.PIE":
            return self._send(200, dataflows_xml(), "application/xml")
        m = re.match(r"^/dataflow/OECD\.STI\.PIE/([^/]+)/([^/]+)$", path)
        if m:
            if m.group(1) not in FLOWS:
                return self._send(404, "not found")
            if q.get("detail") == "referencepartial":   # 일부 서버가 지원하지 않는 경우를 흉내 낸다
                return self._send(501, "Not implemented")
            return self._send(200, structure_xml(m.group(1)), "application/xml")
        m = re.match(r"^/data/OECD\.STI\.PIE,([^,]+),([^/]+)/(.*)$", path)
        if m:
            if STATE["fail_429"]:
                STATE["fail_429"] = False
                return self._send(429, "Too Many Requests")
            if m.group(1) not in FLOWS:
                return self._send(404, "NoResultsFound")
            code, body = data_csv(m.group(1), m.group(3), int(q.get("startPeriod", 1995)), int(q.get("endPeriod", 2022)))
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
