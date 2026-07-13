// Tests for the generalized host-probe harness (spec 006 §11.6).
//
// Two layers, per the repo's testing-strategy rule:
//   - Unit tests against lib.mjs's pure reduction logic, with synthetic payloads whose
//     shape is taken directly from the documented hook stdin contract (006 §5.0) and the
//     MCP-server env contract (006 §4.4) — not from captured program output.
//   - An integration test that spawns `node probe.mjs record-hook` as a real subprocess and
//     pipes real stdin JSON into it, the same way a Claude Code hook actually invokes a
//     command (006 §5.0/§5.1), so a drift in the wire contract (missing `continue`, wrong
//     `hookSpecificOutput.hookEventName`, emitting context on a non-context event) fails
//     this test rather than only a hand-built approximation.
//
// @see docs/specs/006-agent-integration.md §4.4, §5.0, §5.1, §5.4, §11
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import {
  buildHookSighting,
  buildMcpSighting,
  candidateSignalKeys,
  filterEnvByPrefixes,
  summarize,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_MJS = join(HERE, 'probe.mjs');

describe('filterEnvByPrefixes', () => {
  it('keeps only keys starting with a listed prefix, sorted', () => {
    const env = {
      CLAUDE_PROJECT_DIR: '/a',
      PATH: '/bin',
      CLAUDE_CODE_SESSION_ID: 'x',
    };
    expect(filterEnvByPrefixes(env, ['CLAUDE'])).toEqual({
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_PROJECT_DIR: '/a',
    });
  });

  it('returns an empty object when nothing matches (honest absence)', () => {
    expect(filterEnvByPrefixes({ PATH: '/bin' }, ['CLAUDE'])).toEqual({});
  });
});

describe('candidateSignalKeys', () => {
  it('flags SESSION-shaped and PROJECT_DIR/WORKSPACE-shaped keys for an unlisted host', () => {
    const env = {
      CODEX_SESSION_ID: 'x',
      CODEX_WORKSPACE_ROOT: '/w',
      CURSOR_SOMETHING_ELSE: 'y',
    };
    expect(candidateSignalKeys(env)).toEqual({
      sessionIdLike: ['CODEX_SESSION_ID'],
      workspaceLike: ['CODEX_WORKSPACE_ROOT'],
    });
  });
});

describe('buildHookSighting', () => {
  // Spec 006 §5.0: the hook stdin payload carries session_id / hook_event_name / cwd.
  it('records the documented session-identity and workspace-binding fields when present', () => {
    const payload = {
      session_id: '62e1887b-17a0-4b11-890c-3f08843ef898',
      hook_event_name: 'UserPromptSubmit',
      cwd: '/private/tmp/project',
    };
    const sighting = buildHookSighting({ payload, env: {}, pid: 1, ppid: 0 });
    expect(sighting.hookEventName).toBe('UserPromptSubmit');
    expect(sighting.sessionIdentity).toEqual({
      source: 'stdin.session_id',
      present: true,
      value: '62e1887b-17a0-4b11-890c-3f08843ef898',
    });
    expect(sighting.workspaceBinding).toEqual({
      source: 'stdin.cwd',
      present: true,
      value: '/private/tmp/project',
    });
  });

  // Spec 006 §5.2 step 2: a TTY/empty/unparseable stdin stream is treated as `{}` — the
  // harness MUST record that absence honestly, not synthesize a value.
  it('records absent session-identity/workspace-binding fields honestly (empty payload)', () => {
    const sighting = buildHookSighting({
      payload: {},
      env: {},
      pid: 1,
      ppid: 0,
    });
    expect(sighting.hookEventName).toBeNull();
    expect(sighting.sessionIdentity).toEqual({
      source: 'stdin.session_id',
      present: false,
      value: null,
    });
    expect(sighting.workspaceBinding).toEqual({
      source: 'stdin.cwd',
      present: false,
      value: null,
    });
  });

  it('captures only the configured env prefixes alongside the sighting', () => {
    const sighting = buildHookSighting({
      payload: { session_id: 's', hook_event_name: 'SessionStart', cwd: '/w' },
      env: { CLAUDE_PROJECT_DIR: '/w', UNRELATED_VAR: 'nope' },
      envPrefixes: ['CLAUDE'],
      pid: 1,
      ppid: 0,
    });
    expect(sighting.env).toEqual({ CLAUDE_PROJECT_DIR: '/w' });
  });
});

describe('buildMcpSighting', () => {
  // Spec 006 §4.4: a spawned MCP server can read CLAUDE_PROJECT_DIR / CLAUDE_CODE_SESSION_ID
  // from its environment and answer roots/list.
  it('records env signals and roots/list result', () => {
    const sighting = buildMcpSighting({
      phase: 'startup',
      cwd: '/w',
      env: { CLAUDE_PROJECT_DIR: '/w', CLAUDE_CODE_SESSION_ID: 'abc' },
      roots: { supported: true, result: { roots: [{ uri: 'file:///w' }] } },
      capabilitiesDeclared: ['experimental.claude/channel'],
      pid: 1,
      ppid: 0,
    });
    expect(sighting.envSignalKeys).toEqual({
      sessionIdLike: ['CLAUDE_CODE_SESSION_ID'],
      workspaceLike: ['CLAUDE_PROJECT_DIR'],
    });
    expect(sighting.roots?.supported).toBe(true);
  });
});

describe('summarize', () => {
  // This is criterion 2: running the probe in Claude Code must reproduce the 006 §11.3
  // Claude column. Expected values below are taken directly from that spec section, not
  // from a captured probe run:
  //   - session identity: stdin session_id (hooks) + CLAUDE_CODE_SESSION_ID (MCP) — §4.4/§5.0
  //   - workspace binding: stdin cwd (hooks) + CLAUDE_PROJECT_DIR / roots/list (MCP) — §4.4/§5.0
  //   - lifecycle hook points: SessionStart / UserPromptSubmit / PreToolUse / PostToolUse /
  //     Stop are the hooks the activation plugin wires or that fire during a turn (§5.6, §11.3)
  it('reproduces the 006 §11.3 Claude Code column from a full set of sightings', () => {
    const commonPayloadFields = {
      session_id: 'sess-1',
      cwd: '/workspace',
    };
    const hookSightings = [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ].map((hookEventName) =>
      buildHookSighting({
        payload: { ...commonPayloadFields, hook_event_name: hookEventName },
        env: {},
        pid: 1,
        ppid: 0,
      }),
    );
    const mcpSighting = buildMcpSighting({
      phase: 'post-connect',
      cwd: '/workspace',
      env: {
        CLAUDE_PROJECT_DIR: '/workspace',
        CLAUDE_CODE_SESSION_ID: 'sess-1',
      },
      roots: { supported: true, result: {} },
      capabilitiesDeclared: ['experimental.claude/channel'],
      pid: 2,
      ppid: 0,
    });

    const artifact = summarize([...hookSightings, mcpSighting], {
      host: 'claude-code',
      surface: 'cli',
      hostVersion: '2.1.207',
    });

    expect(artifact.host).toBe('claude-code');
    expect(artifact.lifecycleHookPointsFired).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    expect(artifact.sessionIdentitySignal.hook.observed).toBe(true);
    expect(artifact.sessionIdentitySignal.env.observedKeys).toContain(
      'CLAUDE_CODE_SESSION_ID',
    );
    expect(artifact.workspaceBindingSignal.hook.observed).toBe(true);
    expect(artifact.workspaceBindingSignal.env.observedKeys).toContain(
      'CLAUDE_PROJECT_DIR',
    );
    expect(artifact.workspaceBindingSignal.rootsList).toEqual({
      attempted: true,
      supported: true,
    });
    expect(artifact.richerTransport.attempted).toBe(true);
  });

  // Negative: no sightings at all (e.g. a host that was probed but never fired a single
  // hook) MUST NOT be reported as "observed" — an empty artifact is real signal, not a bug.
  it('honestly reports all-absent signals when given zero sightings', () => {
    const artifact = summarize([], {
      host: 'unverified-host',
      surface: 'cli',
      hostVersion: null,
    });
    expect(artifact.lifecycleHookPointsFired).toEqual([]);
    expect(artifact.sessionIdentitySignal.hook.observed).toBe(false);
    expect(artifact.sessionIdentitySignal.env.mechanism).toBeNull();
    expect(artifact.workspaceBindingSignal.hook.observed).toBe(false);
    expect(artifact.richerTransport.attempted).toBe(false);
  });
});

describe('probe.mjs record-hook (real subprocess, real stdin contract)', () => {
  let dir: string;
  let artifactPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'host-probe-record-hook-'));
    artifactPath = join(dir, 'artifact.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runHook(payload: unknown): { stdout: string; parsed: unknown } {
    const stdout = execFileSync(
      'node',
      [PROBE_MJS, 'record-hook', '--out', artifactPath],
      {
        input: JSON.stringify(payload),
        encoding: 'utf8',
      },
    );
    return {
      stdout,
      parsed: stdout.length > 0 ? JSON.parse(stdout) : undefined,
    };
  }

  // 006 §5.1/§5.4: UserPromptSubmit is a context event and MUST get hookSpecificOutput
  // with a matching hookEventName.
  it('emits hookSpecificOutput.additionalContext for a context event (UserPromptSubmit)', () => {
    const { parsed } = runHook({
      session_id: 'sess-real-1',
      hook_event_name: 'UserPromptSubmit',
      cwd: '/private/tmp/project',
    });
    expect(parsed).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit' },
    });
  });

  // 006 §5.4: PreToolUse does NOT honor additionalContext (it uses permissionDecision) —
  // the harness MUST NOT emit hookSpecificOutput for it, matching hook deliver's rule.
  it('omits hookSpecificOutput for a non-context event (PreToolUse)', () => {
    const { parsed } = runHook({
      session_id: 'sess-real-1',
      hook_event_name: 'PreToolUse',
      cwd: '/private/tmp/project',
    });
    expect(parsed).toEqual({ continue: true });
  });

  // Every invocation appends one durable sighting, regardless of context-event status.
  it('appends a sighting reflecting the exact stdin payload it was given', () => {
    runHook({
      session_id: 'sess-real-2',
      hook_event_name: 'Stop',
      cwd: '/private/tmp/other',
    });
    const lines = readFileSync(artifactPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const sighting = JSON.parse(lines[0]);
    expect(sighting.hookEventName).toBe('Stop');
    expect(sighting.sessionIdentity).toEqual({
      source: 'stdin.session_id',
      present: true,
      value: 'sess-real-2',
    });
  });

  // 006 §5.2 step 2: a TTY/empty/unparseable stream is treated as `{}` — never crashes,
  // never hangs, and prints nothing when there is nothing to say.
  it('never crashes on an empty stdin stream and records absence honestly', () => {
    const stdout = execFileSync(
      'node',
      [PROBE_MJS, 'record-hook', '--out', artifactPath],
      {
        input: '',
        encoding: 'utf8',
      },
    );
    expect(JSON.parse(stdout)).toEqual({ continue: true });
    const sighting = JSON.parse(readFileSync(artifactPath, 'utf8').trim());
    expect(sighting.sessionIdentity.present).toBe(false);
  });
});

describe('probe.mjs summarize (real subprocess)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'host-probe-summarize-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('errors clearly when --in is missing or does not exist', () => {
    expect(() =>
      execFileSync(
        'node',
        [PROBE_MJS, 'summarize', '--in', join(dir, 'missing.jsonl')],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    ).toThrow();
  });

  it('reduces a real JSONL artifact written by record-hook into a matrix-cell JSON', () => {
    const artifactPath = join(dir, 'artifact.jsonl');
    execFileSync('node', [PROBE_MJS, 'record-hook', '--out', artifactPath], {
      input: JSON.stringify({
        session_id: 'sess-3',
        hook_event_name: 'SessionStart',
        cwd: '/w',
      }),
      encoding: 'utf8',
    });
    const outPath = join(dir, 'result.json');
    execFileSync(
      'node',
      [
        PROBE_MJS,
        'summarize',
        '--in',
        artifactPath,
        '--out',
        outPath,
        '--host',
        'claude-code',
        '--surface',
        'cli',
        '--host-version',
        '2.1.207',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(result.host).toBe('claude-code');
    expect(result.hostVersion).toBe('2.1.207');
    expect(result.lifecycleHookPointsFired).toEqual(['SessionStart']);
  });
});
