set -euo pipefail

apt-get update >/dev/null
apt-get install -y python3 make g++ >/dev/null

mkdir -p /tmp/repo /tmp/agentmon-home /tmp/npm-cache /tmp/node-gyp /tmp/xdg
cd /workspace
tar --exclude=node_modules --exclude=dist -cf - . | (cd /tmp/repo && tar -xf -)
cd /tmp/repo

corepack enable >/dev/null 2>&1
corepack prepare pnpm@10.30.3 --activate >/dev/null 2>&1

export HOME=/tmp/agentmon-home
export npm_config_cache=/tmp/npm-cache
export npm_config_devdir=/tmp/node-gyp
export XDG_CACHE_HOME=/tmp/xdg

npm install -g @anthropic-ai/claude-code@2.1.80 >/dev/null
CLAUDE_VERSION="$(claude --version | head -n 1)"

pnpm install >/dev/null
pnpm --filter @mike-north/core build >/dev/null
pnpm --filter @mike-north/source-file-fingerprint build >/dev/null
pnpm --filter @mike-north/source-api-poll build >/dev/null
pnpm --filter @mike-north/source-schedule build >/dev/null
pnpm --filter @mike-north/source-incoming-changes build >/dev/null
pnpm --filter @mike-north/cli build >/dev/null

mkdir -p /tmp/workspace/.claude/monitors/watch-files
cat > /tmp/workspace/.claude/monitors/watch-files/MONITOR.md <<'EOF'
---
name: Watch files
source: file-fingerprint
urgency: normal
scope:
  globs:
    - watched.txt
  cwd: "/tmp/workspace"
  interval: "1s"
---
When files change, review them.
EOF

printf 'hello' > /tmp/workspace/watched.txt

export AGENTMONITORS_DB=/tmp/agentmon.db
export AGENTMONITORS_SOCKET=/tmp/agentmon.sock

node apps/cli/dist/index.cjs daemon run /tmp/workspace/.claude/monitors --workspace /tmp/workspace --poll-ms 200 >/tmp/daemon.log 2>&1 &
DAEMON_PID=$!
trap 'kill "$DAEMON_PID" >/dev/null 2>&1 || true' EXIT

for i in $(seq 1 100); do
  if [ -S /tmp/agentmon.sock ]; then
    break
  fi
  sleep 0.1
done

node apps/cli/dist/index.cjs daemon status --format json >/tmp/status.json
STATUS_RUNNING="$(node -e "const fs=require('node:fs'); const status=JSON.parse(fs.readFileSync('/tmp/status.json','utf8')); process.stdout.write(String(status.running))")"
SESSION_JSON="$(node apps/cli/dist/index.cjs session open --host-session-id docker-claude --workspace /tmp/workspace --format json)"
export SESSION_ID="$(node -e "const s=JSON.parse(process.argv[1]); process.stdout.write(s.id)" "$SESSION_JSON")"

sleep 1.2
printf 'hello world' > /tmp/workspace/watched.txt
sleep 1.1

node apps/cli/dist/index.cjs events list --session "$SESSION_ID" --unread --format json >/tmp/events.json
EVENT_COUNT="$(node -e "const fs=require('node:fs'); const events=JSON.parse(fs.readFileSync('/tmp/events.json','utf8')); process.stdout.write(String(events.length))")"
CLAIM_URGENCY="$(node -e "const { execFileSync } = require('node:child_process'); const out = execFileSync('node',['apps/cli/dist/index.cjs','hook','claim','--session',process.env.SESSION_ID,'--lifecycle','turn-interruptible','--format','json'],{encoding:'utf8'}); const parsed = JSON.parse(out); process.stdout.write(parsed.urgency)")"

node apps/cli/dist/index.cjs daemon stop >/tmp/stop.txt
wait "$DAEMON_PID"

echo "CLAUDE_VERSION=$CLAUDE_VERSION"
echo "STATUS_RUNNING=$STATUS_RUNNING"
echo "EVENT_COUNT=$EVENT_COUNT"
echo "CLAIM_URGENCY=$CLAIM_URGENCY"
