"""OECD SDMX API 응답 형태 진단 (GitHub Actions 'OECD API 진단' 워크플로에서 실행).

1) 기본 주소의 dataflow가 외부 참조인지 확인하고 실제 서비스 주소를 찾는다.
2) 실제 주소에서 구조를 받아 scripts/sdmx.py 파서로 차원, 코드 수, 제약을 해석한다.
3) 한국 총수출 등 소량 데이터를 CSV로 받아 열 구성과 첫 줄을 출력한다.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import requests  # noqa: E402
from sdmx import (CSV_ACCEPT, STRUCT_ACCEPT, Flow, assign_roles, parse_dataflows, parse_structure,  # noqa: E402
                  read_sdmx_csv)

AG = "OECD.STI.PIE"
OUT = Path("probe_out")
OUT.mkdir(exist_ok=True)
S = requests.Session()
S.headers["User-Agent"] = "oecd-tiva-gvc-dashboard/1.0 (probe)"
CAND = {"area": ["REF_AREA"], "partner": ["COUNTERPART_AREA"], "measure": ["MEASURE"], "activity": ["ACTIVITY"]}


def get(url, params=None, accept=None):
    time.sleep(7)
    r = S.get(url, params=params, headers={"Accept": accept} if accept else None, timeout=300)
    print(f"\nGET {r.url}\n -> HTTP {r.status_code} {r.headers.get('Content-Type')} {len(r.content):,} bytes")
    return r


r = get("https://sdmx.oecd.org/public/rest/dataflow/OECD.STI.PIE", accept=STRUCT_ACCEPT)
flows = [f for f in parse_dataflows(r.content, AG) if "TIVA" in f.id.upper()]
for f in flows:
    print(" ", f.id, f.version, f.name, "| external:", f.external, "| service:", f.service_base)

for flow_id in (sys.argv[1].split(",") if len(sys.argv) > 1 and sys.argv[1] else ["DSD_TIVA_MAINLV@DF_MAINLV", "DSD_TIVA_MAINSH@DF_MAINSH"]):
    f = next(x for x in flows if x.id == flow_id)
    base = f.service_base or "https://sdmx.oecd.org/public/rest"
    for params in ({"references": "all", "detail": "referencepartial"}, {"references": "all"}):
        rs = get(f"{base}/dataflow/{AG}/{f.id}/{f.version}", params, STRUCT_ACCEPT)
        (OUT / f"{f.id}_{len(params)}.xml").write_bytes(rs.content)
        try:
            fs = parse_structure(rs.content, f)
            assign_roles(fs, CAND)
            print(" dims", fs.dims, "roles", fs.roles, "time", fs.time_range)
            for d in fs.dims:
                print(f"  {d}: 코드목록 {len(fs.codelists.get(d, {}))}개, 제약 {len(fs.allowed.get(d, set()))}개, 예 {fs.codes(d)[:8]}")
            print("  measure 코드", fs.codes(fs.roles["measure"])[:80])
            extra = [d for d in fs.dims if d not in fs.roles.values()]
            print("  역할 외 차원", {d: fs.codes(d)[:10] for d in extra})
            break
        except Exception as e:  # noqa: BLE001
            print(" 구조 해석 실패", e)
    want = [m for m in ("DEXFVApSH", "FEXDVApSH", "EXGR_FVASH", "EXGR_DVAFXSH") if fs.resolve_code(fs.roles["measure"], m)]
    sel = {"area": ["KOR"], "partner": ["CHN", "JPN", "W"], "measure": [fs.resolve_code(fs.roles["measure"], m) for m in want[:2]] or fs.codes(fs.roles["measure"])[:1], "activity": ["_T"]}
    key = ".".join("+".join(sel[next(k for k, v in fs.roles.items() if v == d)]) if d in fs.roles.values() else "" for d in fs.dims)
    for p in ({"startPeriod": "2020", "endPeriod": "2022", "dimensionAtObservation": "AllDimensions", "format": "csvfile"},
              {"startPeriod": "2020", "endPeriod": "2022", "dimensionAtObservation": "AllDimensions"}):
        rd = get(f"{base}/data/{AG},{f.id},{f.version}/{key}", p, CSV_ACCEPT)
        path = OUT / f"{f.id}_data_{len(p)}.csv"
        path.write_bytes(rd.content)
        print(rd.content[:900].decode("utf-8", "replace"))
        if rd.ok:
            try:
                df = read_sdmx_csv(path, fs)
                print(" 해석 결과", len(df), "행\n", df.head(8).to_string())
            except Exception as e:  # noqa: BLE001
                print(" CSV 해석 실패", e)
            break
