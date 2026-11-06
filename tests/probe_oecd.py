"""OECD SDMX API 응답 형태 진단 (GitHub Actions 'OECD API 진단' 워크플로에서 실행).

구조 조회의 여러 방식에 대해 상태 코드, 형식, 최상위 태그, 요소 개수를 출력하고 응답 원문을 probe_out/에 저장한다.
"""
from __future__ import annotations

import collections
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests

BASE = "https://sdmx.oecd.org/public/rest"
AG = "OECD.STI.PIE"
FLOW = sys.argv[1] if len(sys.argv) > 1 else "DSD_TIVA_MAINLV@DF_MAINLV"
DSD = FLOW.split("@")[0]
OUT = Path("probe_out")
OUT.mkdir(exist_ok=True)
S = requests.Session()
S.headers["User-Agent"] = "oecd-tiva-gvc-dashboard/1.0 (probe)"
XML21 = "application/vnd.sdmx.structure+xml;version=2.1"

CASES = [
    ("flow_all_partial", f"{BASE}/dataflow/{AG}/{FLOW}/latest", {"references": "all", "detail": "referencepartial"}, XML21),
    ("flow_all", f"{BASE}/dataflow/{AG}/{FLOW}/latest", {"references": "all"}, XML21),
    ("flow_all_noaccept", f"{BASE}/dataflow/{AG}/{FLOW}/latest", {"references": "all"}, None),
    ("flow_desc", f"{BASE}/dataflow/{AG}/{FLOW}/latest", {"references": "descendants"}, XML21),
    ("dsd_children", f"{BASE}/datastructure/{AG}/{DSD}/latest", {"references": "children"}, XML21),
    ("avail", f"{BASE}/availableconstraint/{AG},{FLOW},latest/all", {"mode": "available"}, XML21),
    ("flow_json", f"{BASE}/dataflow/{AG}/{FLOW}/latest", {"references": "all"}, "application/vnd.sdmx.structure+json;version=1.0;charset=utf-8"),
]


def local(tag):
    return tag.rsplit("}", 1)[-1]


for name, url, params, accept in CASES:
    t0 = time.time()
    try:
        r = S.get(url, params=params, headers={"Accept": accept} if accept else None, timeout=300)
    except Exception as e:  # noqa: BLE001
        print(f"\n### {name} 요청 실패 {e}")
        continue
    body = r.content
    (OUT / f"{name}.txt").write_bytes(body)
    print(f"\n### {name}  HTTP {r.status_code}  {r.headers.get('Content-Type')}  {len(body):,} bytes  {time.time()-t0:.1f}s")
    print("URL", r.url)
    head = body[:600].decode("utf-8", "replace").replace("\n", " ")
    print("HEAD", head)
    if body.lstrip().startswith(b"<"):
        try:
            root = ET.fromstring(body)
            cnt = collections.Counter(local(e.tag) for e in root.iter())
            print("ROOT", local(root.tag))
            print("TAGS", dict(cnt.most_common(40)))
            for e in root.iter():
                if local(e.tag) in ("DataStructure", "Dimension", "TimeDimension", "Codelist", "ContentConstraint", "Dataflow"):
                    print("  ", local(e.tag), dict(list(e.attrib.items())[:5]))
        except ET.ParseError as e:
            print("XML 파싱 오류", e)
    time.sleep(8)
