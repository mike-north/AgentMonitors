set -Eeuo pipefail

# Test-only diagnostics survive --rm and failed outer retrieval: phase commands
# write logs, while a byte-bounded sampler streams recent phase/daemon evidence.
# Raw install/build volume must never count against the outer 20 MiB budget.

LOG_DIR=/tmp/logs
mkdir -p "$LOG_DIR"
CURRENT_PHASE="startup"
DAEMON_PID=""
SAMPLER_PID=""
# Byte bounds also cover giant single-line compiler/npm diagnostics.
TAIL_BYTES=8192
DAEMON_LOG=/tmp/daemon.log

# One sampler for the entire script, independent of phase count/output volume.
# At most 240 one-second samples of two 8 KiB tails (<4 MiB plus labels) fit
# comfortably within outer capture. Its horizon exceeds the 210.5s execution
# allocation; final/ERR tails cover commands finishing between samples. Full
# files remain available for best-effort retrieval until container removal.
node -e '
const fs = require("node:fs");
const path = require("node:path");
const [dir, daemonLog] = process.argv.slice(1);
// Read bounded trailing bytes without loading a potentially huge phase file.
function tail(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, 8192));
    fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return bytes.toString("utf8");
  } catch { return "(no captured log)"; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
// One shared sample budget keeps capture bounded across all phase transitions.
let samples = 0;
const timer = setInterval(() => {
  let phase;
  try { phase = fs.readFileSync(path.join(dir, "current-phase"), "utf8"); }
  catch { return; }
  process.stdout.write(`=== recent phase: ${phase} ===\n${tail(path.join(dir, phase + ".log"))}\n--- recent daemon log ---\n${tail(daemonLog)}\n`);
  if (++samples >= 240) clearInterval(timer);
}, 1000);
' "$LOG_DIR" "$DAEMON_LOG" &
SAMPLER_PID=$!

# Reap only owned diagnostics/daemon processes on ordinary exit. SIGKILL of the
# container cannot run traps, which is why recent evidence is already streamed.
cleanup() {
  if [ -n "$DAEMON_PID" ] && [ "$DAEMON_PID" != "$$" ]; then
    kill "$DAEMON_PID" 2>/dev/null || true
  fi
  kill "$SAMPLER_PID" 2>/dev/null || true
  wait "$SAMPLER_PID" 2>/dev/null || true
}
trap cleanup EXIT

dump_diagnostics() {
  local note="$1"
  {
    echo ""
    echo "=== SMOKE TEST FAILURE: phase \"$CURRENT_PHASE\" — $note ==="
    local phase_log="$LOG_DIR/$CURRENT_PHASE.log"
    if [ -f "$phase_log" ]; then
      echo "--- tail of $phase_log ---"
      tail -c "$TAIL_BYTES" "$phase_log"
    else
      echo "(no captured log for phase \"$CURRENT_PHASE\" at $phase_log)"
    fi
    if [ -f "$DAEMON_LOG" ]; then
      echo "--- tail of /tmp/daemon.log ---"
      tail -c "$TAIL_BYTES" "$DAEMON_LOG"
    fi
    if [ -n "$DAEMON_PID" ]; then
      if kill -0 "$DAEMON_PID" 2>/dev/null; then
        echo "daemon process (pid $DAEMON_PID) is still running at failure time"
      else
        echo "daemon process (pid $DAEMON_PID) is NOT running at failure time"
      fi
    fi
    echo "=== end diagnostics ==="
  } >&2
}
# `set -e` + this ERR trap: any command failing (apt-get, npm, pnpm, node,
# the daemon-readiness check below) aborts the script immediately with full
# diagnostics, rather than falling through into downstream steps that fail
# with a confusing, unrelated-looking error (issue #509's "No daemon running
# for this workspace" probes were exactly this: the readiness wait used to
# fall through silently, and the *next* command — `daemon status` — is what
# actually failed and reported).
trap 'dump_diagnostics "command failed with exit code $?"' ERR
# Failure diagnostics are streamed during phases. The outer helper may retrieve
# remaining logs before forced removal; this TERM trap is best effort only,
# since synchronous child work can delay bash traps and SIGKILL cannot run them.
trap 'dump_diagnostics "received SIGTERM"; exit 143' TERM

phase() {
  CURRENT_PHASE="$1"
  printf %s "$CURRENT_PHASE" >"$LOG_DIR/current-phase"
  echo "=== phase: $CURRENT_PHASE ==="
}

# Runs "$@" with combined stdout+stderr captured to the current phase's log
# file (never discarded) so a failure in this phase is diagnosable.
run_logged() {
  "$@" >"$LOG_DIR/$CURRENT_PHASE.log" 2>&1
  tail -c "$TAIL_BYTES" "$LOG_DIR/$CURRENT_PHASE.log"
}

phase "apt-get-update"
run_logged apt-get update
phase "apt-get-install"
run_logged apt-get install -y python3 make g++

mkdir -p /tmp/repo /tmp/agentmon-home /tmp/npm-cache /tmp/node-gyp /tmp/xdg
cd /workspace
phase "extract-workspace"
run_logged bash -o pipefail -c 'tar --exclude=node_modules --exclude=dist -cf - . | (cd /tmp/repo && tar -xf -)'
cd /tmp/repo

phase "corepack-prepare"
run_logged bash -c 'corepack enable && corepack prepare pnpm@10.30.3 --activate'

export HOME=/tmp/agentmon-home
export npm_config_cache=/tmp/npm-cache
export npm_config_devdir=/tmp/node-gyp
export XDG_CACHE_HOME=/tmp/xdg

phase "npm-install-claude-code"
run_logged npm install -g @anthropic-ai/claude-code@2.1.80
CLAUDE_VERSION="$(claude --version | head -n 1)"

phase "pnpm-install"
run_logged pnpm install
phase "build-core"
run_logged pnpm --filter @agentmonitors/core build
phase "build-source-file-fingerprint"
run_logged pnpm --filter @agentmonitors/source-file-fingerprint build
phase "build-source-api-poll"
run_logged pnpm --filter @agentmonitors/source-api-poll build
phase "build-source-schedule"
run_logged pnpm --filter @agentmonitors/source-schedule build
phase "build-source-incoming-changes"
run_logged pnpm --filter @agentmonitors/source-incoming-changes build
phase "build-source-command-poll"
run_logged pnpm --filter @agentmonitors/source-command-poll build
phase "build-cli"
run_logged pnpm --filter @agentmonitors/cli build

phase "write-monitor-fixture"
mkdir -p /tmp/workspace/.claude/monitors/watch-files
cat > /tmp/workspace/.claude/monitors/watch-files/MONITOR.md <<'EOF'
---
name: Watch files
watch:
  type: file-fingerprint
  globs:
    - watched.txt
  cwd: "/tmp/workspace"
  interval: "1s"
urgency: normal
---
When files change, review them.
EOF

printf 'hello' > /tmp/workspace/watched.txt

export AGENTMONITORS_DB=/tmp/agentmon.db
export AGENTMONITORS_SOCKET=/tmp/agentmon.sock

phase "daemon-start"
node apps/cli/dist/index.cjs daemon run /tmp/workspace/.claude/monitors --workspace /tmp/workspace --poll-ms 200 >"$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!

phase "daemon-readiness-wait"
# The previous fixed 10s budget (100 * 0.1s) lost this race under CI load
# (issue #509): by this point the container has already run apt-get, a
# global npm install, a full `pnpm install`, and 7 package builds, all on a
# 2-core hosted runner — the daemon's own process start can be meaningfully
# delayed by that CPU pressure. 60s is generous headroom over the ~15s used
# by comparable in-process readiness waits elsewhere in this codebase
# (apps/cli/src/daemon-ipc.ts `waitForDaemonAvailable` callers: 15s for
# `daemon run --detach`, 15s for `verify --use-workspace-daemon`, 8s for
# `session start`'s lazy boot) while still leaving margin inside this
# outer container execution allocation (derived in smoke-container.ts) — the
# loop returns as soon as the socket appears, so on the (overwhelmingly
# common) happy path this budget costs nothing; it is only spent when
# something is already broken, which is exactly when the diagnostics below
# matter.
READY_TIMEOUT_S=60
READY_POLL_MS=200
READY_MAX_ITERS=$((READY_TIMEOUT_S * 1000 / READY_POLL_MS))
ready=false
daemon_exit_code=""
iters_waited=0
for i in $(seq 1 "$READY_MAX_ITERS"); do
  iters_waited=$i
  if [ -S /tmp/agentmon.sock ]; then
    ready=true
    break
  fi
  # Distinguish "the daemon process died" from "it just hasn't bound the
  # socket yet" (issue #509 acceptance criterion 2): if the process is
  # already gone, waiting out the rest of the budget only delays reporting
  # a crash as a crash.
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    # NOTE: `set +e` does NOT suppress the ERR trap in bash — only being
    # the test of an if/while, or negated with !, does (verified against a
    # real crashed-daemon run: `set +e; wait ...` still fired the trap).
    # This if/else form is the correct idiom for capturing an expected
    # non-zero exit code without tripping `set -Eeuo pipefail`'s ERR trap.
    if wait "$DAEMON_PID"; then
      daemon_exit_code=0
    else
      daemon_exit_code=$?
    fi
    break
  fi
  sleep 0.2
done

if [ "$ready" != "true" ]; then
  elapsed_s=$((iters_waited * READY_POLL_MS / 1000))
  if [ -n "$daemon_exit_code" ]; then
    dump_diagnostics "daemon process exited before its socket became ready (exit code $daemon_exit_code, after ~${elapsed_s}s / $iters_waited polls)"
  else
    still_running="not running"
    if kill -0 "$DAEMON_PID" 2>/dev/null; then
      still_running="still running"
    fi
    dump_diagnostics "daemon socket did not appear within ${READY_TIMEOUT_S}s (waited ~${elapsed_s}s across $iters_waited polls); daemon process $DAEMON_PID is $still_running"
  fi
  exit 1
fi

phase "daemon-status-probe"
node apps/cli/dist/index.cjs daemon status --format json >/tmp/status.json
STATUS_RUNNING="$(node -e "const fs=require('node:fs'); const status=JSON.parse(fs.readFileSync('/tmp/status.json','utf8')); process.stdout.write(String(status.running))")"

phase "session-open"
SESSION_JSON="$(node apps/cli/dist/index.cjs session open --host-session-id docker-claude --workspace /tmp/workspace --format json)"
SESSION_ID="$(node -e "const s=JSON.parse(process.argv[1]); process.stdout.write(s.id)" "$SESSION_JSON")"
export SESSION_ID

phase "await-observation-settle"
sleep 1.2
printf 'hello world' > /tmp/workspace/watched.txt
sleep 1.1

phase "events-list"
node apps/cli/dist/index.cjs events list --session "$SESSION_ID" --unread --format json >/tmp/events.json
EVENT_COUNT="$(node -e "const fs=require('node:fs'); const events=JSON.parse(fs.readFileSync('/tmp/events.json','utf8')); process.stdout.write(String(events.length))")"

phase "hook-claim"
CLAIM_URGENCY="$(node -e "const { execFileSync } = require('node:child_process'); const out = execFileSync('node',['apps/cli/dist/index.cjs','hook','claim','--session',process.env.SESSION_ID,'--lifecycle','turn-interruptible','--format','json'],{encoding:'utf8'}); const parsed = JSON.parse(out); process.stdout.write(parsed.urgency)")"

phase "daemon-stop"
node apps/cli/dist/index.cjs daemon stop >/tmp/stop.txt
wait "$DAEMON_PID"

echo "CLAUDE_VERSION=$CLAUDE_VERSION"
echo "STATUS_RUNNING=$STATUS_RUNNING"
echo "EVENT_COUNT=$EVENT_COUNT"
echo "CLAIM_URGENCY=$CLAIM_URGENCY"
