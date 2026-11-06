#!/usr/bin/env bash
# 로컬 검증. 가짜 OECD SDMX 서버(tests/mock_oecd.py)로 수집과 가공 전체 흐름을 실행한다.
# 합성 데이터이므로 결과를 분석에 쓰지 않는다. 저장소의 data/, docs/data/는 건드리지 않는다.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
PORT=${PORT:-8765}

python "$ROOT/tests/mock_oecd.py" --port "$PORT" --too-large 200000 --fail-first-429 > "$TMP/mock.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$TMP"' EXIT
sleep 3

TIVA_MIN_INTERVAL=0 python "$ROOT/scripts/fetch_tiva.py" \
  --base-url "http://127.0.0.1:$PORT/public/rest" --out "$TMP/processed" --cache "$TMP/cache"
python "$ROOT/scripts/build_dashboard_data.py" --data "$TMP/processed" --out "$TMP/site_data"

python - "$TMP" <<'PY'
import json, sys
from pathlib import Path
tmp = Path(sys.argv[1])
d = tmp / "site_data"
qa = json.loads((d / "qa.json").read_text(encoding="utf-8"))
bad = [c for c in qa["checks"] if not c["ok"]]
assert not bad, f"품질 점검 실패: {bad}"
meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
assert meta["edition"] == 2025 and len(meta["top"]) == 20
ind = json.loads((d / "industry" / "_T.json").read_text(encoding="utf-8"))
assert all(abs(v - 1) < 1e-6 for v in ind["data"]["KOR"]["rca"] if v is not None), "전 산업 RCA는 1이어야 함"
for f in ["countries.json", "partner/KOR.json", "partner/R_EU.json", "profile/R_ASIA.json", "industry/C301.json"]:
    assert (d / f).exists(), f
print("모의 서버 검증 통과:", len(qa["checks"]), "개 점검,", sum(1 for _ in d.rglob('*.json')), "개 JSON")
PY
