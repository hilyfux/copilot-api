#!/usr/bin/env bash
# smoke-dual-protocol.sh — reproducible end-to-end check of both client faces.
#
# Purpose (iron rule #4: 结论 ⟸ 测试): prove that this fork actually serves
#   - OpenAI     POST /v1/chat/completions   (non-stream + SSE stream)
#   - Anthropic  POST /v1/messages           (non-stream + SSE stream)
#   - GET  /v1/models
#   - gateway API-key auth (401 without a key, 200 with one)
# against a stub OpenAI-compatible upstream, so the HTTP surface can be
# verified with no GitHub Copilot credentials and no network egress.
#
# Usage:  bash scripts/smoke-dual-protocol.sh
# Exit:   0 = all assertions passed, 1 = a failure (with the reason printed).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="$(mktemp -d)"
UPSTREAM_PORT="${SMOKE_UPSTREAM_PORT:-19911}"
SERVER_PORT="${SMOKE_SERVER_PORT:-14141}"
KEY="smoke-test-key"
FAILURES=0
UP_PID=""
SRV_PID=""

cleanup() {
  [[ -n "$SRV_PID" ]] && kill "$SRV_PID" 2>/dev/null
  [[ -n "$UP_PID" ]] && kill "$UP_PID" 2>/dev/null
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

# ── stub upstream ───────────────────────────────────────────────────────────
cat > "$HOME_DIR/upstream.py" <<'PY'
import json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def _j(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self._j({"object":"list","data":[{"id":"mock-model","object":"model","owned_by":"mock"}]})
        self._j({"error":"not found"},404)
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        req = json.loads(self.rfile.read(n) or b"{}")
        pieces = ["Hello"," from"," stub","."]
        if not req.get("stream"):
            return self._j({"id":"chatcmpl-smoke","object":"chat.completion","created":int(time.time()),
                "model":req.get("model","mock-model"),
                "choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"".join(pieces)}}],
                "usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}})
        self.send_response(200)
        self.send_header("content-type","text/event-stream")
        self.send_header("cache-control","no-cache")
        self.end_headers()
        for p in pieces:
            self.wfile.write(("data: "+json.dumps({"id":"chatcmpl-smoke","object":"chat.completion.chunk",
                "created":int(time.time()),"model":req.get("model","mock-model"),
                "choices":[{"index":0,"delta":{"content":p},"finish_reason":None}]})+"\n\n").encode())
            self.wfile.flush(); time.sleep(0.01)
        self.wfile.write(("data: "+json.dumps({"id":"chatcmpl-smoke","object":"chat.completion.chunk",
            "created":int(time.time()),"model":req.get("model","mock-model"),
            "choices":[{"index":0,"delta":{},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}})+"\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()

ThreadingHTTPServer(("127.0.0.1", int(__import__("sys").argv[1])), H).serve_forever()
PY

python3 "$HOME_DIR/upstream.py" "$UPSTREAM_PORT" &
UP_PID=$!

cat > "$HOME_DIR/config.json" <<JSON
{
  "auth": { "apiKeys": ["$KEY"] },
  "providers": {
    "mock": {
      "type": "openai-compatible",
      "enabled": true,
      "baseUrl": "http://127.0.0.1:$UPSTREAM_PORT/v1",
      "apiKey": "stub-upstream-key",
      "models": { "mock-model": {} }
    }
  }
}
JSON

for _ in $(seq 1 50); do
  curl -sf -m 1 "http://127.0.0.1:$UPSTREAM_PORT/v1/models" >/dev/null && break
  sleep 0.1
done

# ── server under test ───────────────────────────────────────────────────────
( cd "$ROOT" && COPILOT_API_HOME="$HOME_DIR" bun run ./src/main.ts start \
    --port "$SERVER_PORT" --host 127.0.0.1 >"$HOME_DIR/server.log" 2>&1 ) &
SRV_PID=$!

READY=0
for _ in $(seq 1 100); do
  if curl -sf -m 1 "http://127.0.0.1:$SERVER_PORT/" >/dev/null 2>&1; then READY=1; break; fi
  sleep 0.2
done
if [[ "$READY" != 1 ]]; then
  echo "server failed to start; log follows:"
  cat "$HOME_DIR/server.log"
  exit 1
fi

BASE="http://127.0.0.1:$SERVER_PORT"
AUTH=(-H "Authorization: Bearer $KEY")

echo "dual-protocol smoke (server $BASE, upstream 127.0.0.1:$UPSTREAM_PORT)"

# 1. liveness
[[ "$(curl -s -m 5 "$BASE/")" == "Server running" ]] \
  && pass "GET / is alive" || fail "GET / is alive"

# 2. auth enforced
[[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BASE/v1/models")" == "401" ]] \
  && pass "unauthenticated request is rejected with 401" \
  || fail "unauthenticated request is rejected with 401"

# 3. model listing — provider-qualified ids are the contract here
MODELS="$(curl -s -m 8 "${AUTH[@]}" "$BASE/v1/models")"
echo "$MODELS" | grep -q '"mock/mock-model"' \
  && pass "GET /v1/models lists the provider-qualified model" \
  || fail "GET /v1/models lists the provider-qualified model"

# 4. OpenAI protocol, non-streaming
OAI="$(curl -s -m 15 "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"model":"mock/mock-model","messages":[{"role":"user","content":"hi"}]}' \
  "$BASE/v1/chat/completions")"
echo "$OAI" | grep -q 'Hello from stub' \
  && pass "OpenAI /v1/chat/completions returns the upstream answer" \
  || fail "OpenAI /v1/chat/completions returns the upstream answer"

# 5. Anthropic protocol, non-streaming
ANT="$(curl -s -m 15 "${AUTH[@]}" -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"mock-model","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}' \
  "$BASE/mock/v1/messages")"
echo "$ANT" | grep -q '"type":"message"' \
  && pass "Anthropic /v1/messages returns an Anthropic message" \
  || fail "Anthropic /v1/messages returns an Anthropic message"
echo "$ANT" | grep -q 'Hello from stub' \
  && pass "Anthropic /v1/messages carries the translated text" \
  || fail "Anthropic /v1/messages carries the translated text"
echo "$ANT" | grep -q '"input_tokens":11' \
  && pass "Anthropic /v1/messages reports usage tokens" \
  || fail "Anthropic /v1/messages reports usage tokens"

# 6. Anthropic protocol, SSE streaming
STREAM="$(curl -s -m 20 -N "${AUTH[@]}" -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"mock-model","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}' \
  "$BASE/mock/v1/messages")"
for ev in message_start content_block_start content_block_delta message_stop; do
  echo "$STREAM" | grep -q "event: $ev" \
    && pass "Anthropic stream emits $ev" \
    || fail "Anthropic stream emits $ev"
done

# 7. OpenAI protocol, SSE streaming
OAI_STREAM="$(curl -s -m 20 -N "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"model":"mock/mock-model","stream":true,"messages":[{"role":"user","content":"hi"}]}' \
  "$BASE/v1/chat/completions")"
echo "$OAI_STREAM" | grep -q 'chat.completion.chunk' \
  && pass "OpenAI stream emits chunk frames" \
  || fail "OpenAI stream emits chunk frames"
echo "$OAI_STREAM" | grep -q '\[DONE\]' \
  && pass "OpenAI stream terminates with [DONE]" \
  || fail "OpenAI stream terminates with [DONE]"

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "RESULT: all checks passed"
  exit 0
fi
echo "RESULT: $FAILURES check(s) failed"
exit 1
