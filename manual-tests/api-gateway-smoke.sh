#!/usr/bin/env bash
#
# Smoke test for the remote HTTP API gateway.
#
# The gateway is ON by default — just launch the app normally:
#
#      npm run start          # or: npm run dev
#
# The main-process log should print:
#      [ApiGateway] listening on http://0.0.0.0:8765 — NO AUTH ...
#
# Then, from this machine or any host that can reach this machine's IP:
#
#      API_BASE=http://<this-machine-ip>:8765 bash manual-tests/api-gateway-smoke.sh
#
# Auth is OPTIONAL: if you launched with CMB_API_TOKEN=<secret>, pass the same
# value here as TOKEN=<secret> and requests will include the bearer header.
#
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:8765}"
TOKEN="${TOKEN:-}"
# Optional workspace directory the agent may operate in. Empty → inherit the
# app's last-used workspace.
WORKSPACE="${WORKSPACE:-}"
MESSAGE="${MESSAGE:-用一句话介绍你自己}"

auth=()
[[ -n "${TOKEN}" ]] && auth=(-H "Authorization: Bearer ${TOKEN}")

echo "== 1. health =="
curl -sS "${API_BASE}/healthz"; echo

echo "== 2. create thread =="
if [[ -n "${WORKSPACE}" ]]; then
  body=$(printf '{"metadata":{"workspacePath":"%s"}}' "${WORKSPACE}")
else
  body='{}'
fi
create=$(curl -sS "${auth[@]}" -H "Content-Type: application/json" \
  -d "${body}" "${API_BASE}/v1/threads")
echo "${create}"
THREAD_ID=$(printf '%s' "${create}" | sed -n 's/.*"thread_id":"\([^"]*\)".*/\1/p')
echo "thread_id=${THREAD_ID}"
[[ -n "${THREAD_ID}" ]] || { echo "failed to create thread"; exit 1; }

echo "== 3. send message, stream reply over SSE (Ctrl-C to stop) =="
echo "   (each 'data:' line is one stream chunk; ends at {\"type\":\"done\"})"
curl -sS -N "${auth[@]}" -H "Content-Type: application/json" \
  -d "{\"message\":\"${MESSAGE}\"}" \
  "${API_BASE}/v1/threads/${THREAD_ID}/messages"

echo
echo "== 4. (optional) cancel a running turn =="
echo "   curl -sS ${auth[*]} -X POST ${API_BASE}/v1/threads/${THREAD_ID}/cancel"
