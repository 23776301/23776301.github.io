#!/bin/bash
# 清理 GitHub Actions workflow runs 和 deployments
# 用法: ./cleanup-runs.sh [token]
# 不传 token 则使用 gh CLI 认证

set -e

REPO="teecatt/teecatt.github.io"
TOKEN="${1:-$(gh auth token 2>/dev/null || echo '')}"

if [ -z "$TOKEN" ]; then
  echo "Usage: $0 <github-token>"
  exit 1
fi

AUTH="Authorization: token $TOKEN"
API="https://api.github.com/repos/$REPO"

echo "=== Cleaning workflow runs ==="
while true; do
  IDS=$(curl -s -H "$AUTH" "$API/actions/runs?per_page=100" | python3 -c "
import sys,json
d=json.load(sys.stdin)
runs=d.get('workflow_runs',[])
if not runs: sys.exit(0)
for r in runs: print(r['id'])
" 2>/dev/null)
  [ -z "$IDS" ] && break
  COUNT=0
  for id in $IDS; do
    curl -s -X DELETE -H "$AUTH" "$API/actions/runs/$id" > /dev/null 2>&1
    COUNT=$((COUNT+1))
  done
  echo "  Deleted $COUNT runs"
done
echo "  Done"

echo "=== Cleaning deployments ==="
while true; do
  IDS=$(curl -s -H "$AUTH" "$API/deployments?per_page=100" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if not d: sys.exit(0)
for r in d: print(r['id'])
" 2>/dev/null)
  [ -z "$IDS" ] && break
  COUNT=0
  for id in $IDS; do
    curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
      -d '{"state":"inactive"}' "$API/deployments/$id/statuses" > /dev/null 2>&1
    curl -s -X DELETE -H "$AUTH" "$API/deployments/$id" > /dev/null 2>&1
    COUNT=$((COUNT+1))
  done
  echo "  Deleted $COUNT deployments"
done
echo "  Done"

echo "=== Summary ==="
RUNS=$(curl -s -H "$AUTH" "$API/actions/runs?per_page=1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('total_count',0))" 2>/dev/null)
DEPS=$(curl -s -H "$AUTH" "$API/deployments?per_page=100" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null)
echo "  Workflow runs: $RUNS"
echo "  Deployments: $DEPS"
