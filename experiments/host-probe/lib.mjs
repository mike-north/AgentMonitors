// Shared, pure(ish) logic for the generalized host-probe harness (spec 006 §11.6).
//
// Kept separate from probe.mjs (the CLI entry / process-boundary code) so the
// parsing/reduction logic is unit-testable without spawning a real hook subprocess
// or MCP server (see probe.test.ts).

/** Env var prefixes worth capturing at full value (identifiers/paths, not secrets). */
export const DEFAULT_ENV_PREFIXES = ['CLAUDE', 'CODEX', 'CURSOR'];

/** Heuristics for spotting identity/workspace-shaped env vars on an unlisted host. */
const SESSION_ID_KEY_PATTERN = /SESSION/i;
const WORKSPACE_KEY_PATTERN = /PROJECT_DIR|WORKSPACE|ROOT_DIR/i;

/**
 * Filter `env` down to keys that start with one of `prefixes` (case-sensitive,
 * matching the repo's existing CLAUDE_* convention), sorted for deterministic output.
 */
export function filterEnvByPrefixes(env, prefixes = DEFAULT_ENV_PREFIXES) {
  const out = {};
  for (const key of Object.keys(env).sort()) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      out[key] = env[key];
    }
  }
  return out;
}

/**
 * Key names (not values) among `env` that look identity- or workspace-shaped.
 * A key only counts when it is actually present with a non-empty value in this
 * sighting — an empty/undefined variable is not evidence the host provides the
 * signal, and would produce false positives in the reduced artifact.
 */
export function candidateSignalKeys(env) {
  const keys = Object.keys(env).filter(
    (k) => typeof env[k] === 'string' && env[k].length > 0,
  );
  return {
    sessionIdLike: keys.filter((k) => SESSION_ID_KEY_PATTERN.test(k)).sort(),
    workspaceLike: keys.filter((k) => WORKSPACE_KEY_PATTERN.test(k)).sort(),
  };
}

/**
 * Build one JSONL "sighting" record for a `record-hook` invocation.
 *
 * Mirrors the documented hook stdin contract (006 §5.0): `session_id` is the
 * session-identity signal, `cwd` is the workspace-binding signal, `hook_event_name`
 * is the firing lifecycle-hook name. Records presence/absence honestly — a missing
 * field is a real finding, not an error.
 */
export function buildHookSighting({
  payload,
  env,
  envPrefixes = DEFAULT_ENV_PREFIXES,
  pid,
  ppid,
  at = new Date().toISOString(),
}) {
  const filteredEnv = filterEnvByPrefixes(env, envPrefixes);
  return {
    mode: 'hook',
    at,
    hookEventName: payload.hook_event_name ?? null,
    payloadKeys: Object.keys(payload).sort(),
    sessionIdentity: {
      source: 'stdin.session_id',
      present:
        typeof payload.session_id === 'string' && payload.session_id.length > 0,
      value: payload.session_id ?? null,
    },
    workspaceBinding: {
      source: 'stdin.cwd',
      present: typeof payload.cwd === 'string' && payload.cwd.length > 0,
      value: payload.cwd ?? null,
    },
    env: filteredEnv,
    envSignalKeys: candidateSignalKeys(filteredEnv),
    pid,
    ppid,
  };
}

/**
 * Build one JSONL "sighting" record for a `record-mcp` invocation (the richer,
 * additive-transport analogue — a channel/push server, generalizing
 * experiments/channel-probe). Records env + roots/list, the two documented
 * workspace-binding signals for a spawned MCP server (006 §4.4).
 */
export function buildMcpSighting({
  phase,
  cwd,
  env,
  envPrefixes = DEFAULT_ENV_PREFIXES,
  roots,
  capabilitiesDeclared,
  pid,
  ppid,
  at = new Date().toISOString(),
}) {
  const filteredEnv = filterEnvByPrefixes(env, envPrefixes);
  return {
    mode: 'mcp',
    at,
    phase,
    cwd,
    env: filteredEnv,
    envSignalKeys: candidateSignalKeys(filteredEnv),
    roots: roots ?? null,
    capabilitiesDeclared: capabilitiesDeclared ?? [],
    pid,
    ppid,
  };
}

/**
 * Reduce an array of sightings (hook + mcp) into the single matrix-cell artifact
 * shape acceptance criterion 1 asks for: host + version, the session-identity
 * signal, the workspace-binding signal, and which lifecycle hook points fired.
 */
export function summarize(
  sightings,
  { host, surface, hostVersion, notes = [] },
) {
  const hookSightings = sightings.filter((s) => s.mode === 'hook');
  const mcpSightings = sightings.filter((s) => s.mode === 'mcp');

  const lifecycleHookPointsFired = Array.from(
    new Set(hookSightings.map((s) => s.hookEventName).filter((v) => v != null)),
  ).sort();

  const hookSessionIdObserved = hookSightings.some(
    (s) => s.sessionIdentity.present,
  );
  const hookWorkspaceObserved = hookSightings.some(
    (s) => s.workspaceBinding.present,
  );

  // An env var is only reported as an observed identity/workspace signal if it was
  // present (non-empty) on at least one sighting; report the *names* seen, not raw
  // values, to keep the artifact safe to diff/commit.
  const envSessionIdKeys = Array.from(
    new Set(
      [...hookSightings, ...mcpSightings].flatMap(
        (s) => s.envSignalKeys.sessionIdLike,
      ),
    ),
  ).sort();
  const envWorkspaceKeys = Array.from(
    new Set(
      [...hookSightings, ...mcpSightings].flatMap(
        (s) => s.envSignalKeys.workspaceLike,
      ),
    ),
  ).sort();

  const rootsSightings = mcpSightings.filter((s) => s.roots != null);
  const rootsSupported = rootsSightings.some((s) => s.roots.supported === true);

  return {
    host,
    surface,
    hostVersion: hostVersion ?? null,
    probedAt: new Date().toISOString(),
    sessionIdentitySignal: {
      hook: {
        mechanism: 'stdin.session_id',
        observed: hookSessionIdObserved,
      },
      env: {
        mechanism:
          envSessionIdKeys.length > 0
            ? `env.${envSessionIdKeys.join('|')}`
            : null,
        observedKeys: envSessionIdKeys,
      },
    },
    workspaceBindingSignal: {
      hook: {
        mechanism: 'stdin.cwd',
        observed: hookWorkspaceObserved,
      },
      env: {
        mechanism:
          envWorkspaceKeys.length > 0
            ? `env.${envWorkspaceKeys.join('|')}`
            : null,
        observedKeys: envWorkspaceKeys,
      },
      rootsList: {
        attempted: rootsSightings.length > 0,
        supported: rootsSupported,
      },
    },
    lifecycleHookPointsFired,
    richerTransport: {
      attempted: mcpSightings.length > 0,
      capabilitiesDeclared: Array.from(
        new Set(mcpSightings.flatMap((s) => s.capabilitiesDeclared)),
      ).sort(),
    },
    sightingCounts: {
      hook: hookSightings.length,
      mcp: mcpSightings.length,
    },
    notes,
  };
}
