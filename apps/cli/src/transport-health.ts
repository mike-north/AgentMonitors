import path from 'node:path';
import type { HookDeliveryDiagnosis } from '@agentmonitors/core';
import {
  isHeartbeatStale,
  type TransportHeartbeat,
  type TransportName,
} from './transport-heartbeat.js';

/**
 * "What is the listening method for THIS session, and is it actually
 * healthy?" — computed as a pure function of the transport registry, the
 * daemon's reachability, this workspace's lead sessions, and the daemon's own
 * delivery diagnosis (issue #425).
 *
 * ## Why this surface exists
 *
 * Monitored changes have failed to reach an agent in three distinct ways, and
 * every one of them was silent — the monitor looked healthy, events were
 * materialized correctly, and the agent was simply never told:
 *
 * 1. **No daemon for the workspace.** A hook-lazy-booted daemon reaped while an
 *    idle listener fired no hooks to revive it. Nothing anywhere said "there is
 *    no daemon for this workspace".
 * 2. **A channel bound to the wrong workspace.** A session launched from `$HOME`
 *    resolved the home-directory workspace, so its channel server delivered
 *    events for a workspace whose monitors nobody was waiting on.
 * 3. **Reminders suppressed by coalesced-until-ack.** Events materialized on
 *    real transitions (including a CI failure) but every lead session's
 *    normal-urgency reminder was withheld because one earlier unread event was
 *    already claimed (002 §9.2/§9.3).
 *
 * The third case is the reason this is a *health* surface and not a *liveness*
 * surface: both transports were up, connected, and correctly configured. A
 * transport whose reminders are currently muted is **not healthy**, because the
 * only thing a user cares about — "will I be told?" — is false. Every failure
 * mode below is therefore reported with its own code and its own remediation,
 * and is never collapsed into a generic "unhealthy".
 *
 * ## Why this lives in the CLI, not core
 *
 * Core owns delivery semantics and is host-agnostic; it already computes the
 * suppression verdict this module consumes (`diagnoseHookDelivery`). What this
 * module adds is entirely host/process-level: which OS processes are listening,
 * which binary and `HOME` they resolved, which socket they bound. Those are CLI
 * and host-integration facts, so composing them here keeps core free of
 * process-topology concerns rather than inventing new delivery behavior (AP6).
 *
 * @see ../../../docs/specs/006-agent-integration.md §12 (transport health)
 * @see ../../../docs/specs/002-runtime-delivery.md §9 (delivery lifecycles)
 */

/**
 * A distinct, individually-remediable transport failure. Each code names one
 * concrete cause with one concrete fix — deliberately not a severity ladder,
 * because two of these (a misbound channel and muted reminders) look identical
 * from the outside yet need completely different actions.
 */
export type TransportProblemCode =
  /** (a) No daemon is reachable for this workspace: nothing can deliver. */
  | 'daemon-unreachable'
  /** (b) A transport for this host session is bound to a different workspace. */
  | 'workspace-mismatch'
  /** (b') A transport is bound to a different daemon socket than we resolve. */
  | 'socket-mismatch'
  /** (b'') A transport resolved a different HOME / data root than we did. */
  | 'environment-mismatch'
  /** (c) Reminders are currently withheld by the coalesced-until-ack guard. */
  | 'reminders-suppressed'
  /** (d) A transport heartbeat exists but its lease has expired. */
  | 'heartbeat-stale'
  /** A long-lived transport is running an older CLI than this one. */
  | 'version-skew'
  /** The channel is up, but host-side channel registration is unprovable here. */
  | 'channel-registration-unverified'
  /**
   * (c') Whether reminders are suppressed could not be determined for one or
   * more lead sessions — the daemon's `hook.diagnose` call failed (e.g. an
   * older daemon that rejects it as unsupported). Distinct from
   * `reminders-suppressed`: that code means the check ran and found an active
   * suppression; this one means the check never ran at all, so a suppression
   * could be silently active. `deliverable` must not read `true` while this is
   * present (issue #425 review, round 4).
   */
  | 'delivery-diagnosis-unavailable';

/**
 * Problems that belong to the delivery pipeline as a whole rather than to one
 * transport. They are attached to EVERY configured transport — a down daemon or
 * a muted reminder blocks the hook and channel paths alike, and reporting
 * either against a single transport would imply the other one still works — but
 * a renderer must report them ONCE, at the verdict, instead of repeating them
 * per row. {@link isSharedProblem} is that filter.
 */
const SHARED_PROBLEM_CODES: readonly TransportProblemCode[] = [
  'daemon-unreachable',
  'reminders-suppressed',
  'delivery-diagnosis-unavailable',
];

/** Whether a problem is pipeline-wide (report once) or transport-owned. */
export function isSharedProblem(code: TransportProblemCode): boolean {
  return SHARED_PROBLEM_CODES.includes(code);
}

export interface TransportProblem {
  code: TransportProblemCode;
  /** What is wrong, naming the concrete conflicting values. */
  detail: string;
  /** The exact next step — always a command or a specific action. */
  remediation: string;
}

/** What a transport is bound to, as the transport itself reported it. */
export interface TransportBinding {
  workspacePath: string;
  socketPath: string;
  home: string;
  dataRoot: string;
  pid: number;
  cliPath: string;
  hostSessionId?: string;
}

export interface TransportStatus {
  name: TransportName;
  /** Whether this transport has ever reported in for this workspace/session. */
  configured: boolean;
  /** Whether it is currently within its heartbeat lease. */
  running: boolean;
  /** `configured && running` with no problems that would block delivery. */
  healthy: boolean;
  boundTo?: TransportBinding;
  version?: string;
  /** ISO 8601, or `null` when this transport has never delivered. */
  lastDelivery: string | null;
  problems: TransportProblem[];
}

/** Which listening method will actually reach this session right now. */
export type DeliveryReach = 'hook' | 'channel' | 'both' | 'none';

export interface DeliveryTransportHealth {
  transports: TransportStatus[];
  /**
   * Problems that belong to the pipeline rather than to any transport (a down
   * daemon, muted reminders).
   *
   * Surfaced here as well as on each configured transport because they must
   * stay visible when NO transport is configured — otherwise the single worst
   * case disappears: reminders muted on a workspace whose transports have not
   * reported in would render as a bland "nothing is listening", hiding the fact
   * that acknowledging the claimed events is also required before anything can
   * arrive. A renderer should read this list; `transports[].problems[]` carries
   * the same entries for consumers inspecting one transport in isolation.
   */
  pipelineProblems: TransportProblem[];
  /**
   * The listening method(s) currently able to reach this session. This names
   * the *method*, so it stays `hook`/`channel`/`both` even while delivery is
   * muted by suppression — a muted transport is still the listening method.
   * Read it together with {@link DeliveryTransportHealth.deliverable}, which is
   * the "will I actually be told?" answer.
   */
  deliveryWillReachThisSession: DeliveryReach;
  /**
   * `false` when nothing would reach the agent right now — no transport, no
   * daemon, or every reminder currently suppressed. This is the field that
   * makes case (3) above visible; `deliveryWillReachThisSession` alone would
   * have reported a cheerful `both` throughout that incident.
   */
  deliverable: boolean;
  /** One human-readable line stating the verdict. */
  verdict: string;
  /** De-duplicated remediation steps across every transport, in report order. */
  remediation: string[];
}

const CHANNEL_DEV_FLAG =
  '--dangerously-load-development-channels plugin:agentmonitors@agentmonitors';

/**
 * Inputs the health verdict is derived from. Every value is passed in rather
 * than read here so the whole computation stays pure and directly testable —
 * each failure mode can be constructed exactly, without a live daemon.
 */
export interface TransportHealthInput {
  workspacePath: string;
  /** The socket `doctor` itself resolved for this workspace. */
  socketPath: string;
  daemonRunning: boolean;
  /** Why the daemon call failed, when it did (threaded into the detail). */
  daemonErrorMessage?: string;
  /** Host session ids of lead sessions registered for this workspace. */
  leadHostSessionIds: readonly string[];
  /** Every heartbeat in the machine-wide registry. */
  heartbeats: readonly TransportHeartbeat[];
  /** Per-lead-session delivery diagnoses, when the daemon was reachable. */
  diagnoses: readonly HookDeliveryDiagnosis[];
  /**
   * Ids of lead sessions whose delivery diagnosis could not be obtained (the
   * daemon's `hook.diagnose` call threw). Non-empty here means the
   * suppression check was skipped for at least one session — not that it ran
   * and found nothing — so it must block `deliverable` rather than being
   * indistinguishable from "no suppression".
   */
  diagnosisUnavailableSessionIds: readonly string[];
  /** This CLI's own version, for skew comparison. */
  cliVersion: string;
  /**
   * `HOME` as THIS command resolves it — supplied by the caller (`doctor`)
   * rather than read here, so `computeTransportHealth` stays a pure function
   * of its input (every failure mode constructible in a test without a real
   * `os.homedir()`/env dependency).
   */
  expectedHome: string;
  /** Data root as THIS command resolves it — same purity rationale. */
  expectedDataRoot: string;
  now: Date;
}

function daemonProblem(input: TransportHealthInput): TransportProblem {
  const cause = input.daemonErrorMessage ? `: ${input.daemonErrorMessage}` : '';
  return {
    code: 'daemon-unreachable',
    detail:
      `No daemon is reachable at ${input.socketPath} for workspace ` +
      `"${input.workspacePath}"${cause}. No transport can deliver monitor ` +
      `events while the daemon is down, however healthy the transports ` +
      `themselves look.`,
    remediation:
      'Start it with `agentmonitors daemon run` (it also starts automatically ' +
      'when a Claude Code session opens in this workspace).',
  };
}

/**
 * Compare a transport's frozen binding against what we resolve *now*.
 *
 * These three checks are separate codes on purpose. A workspace mismatch means
 * the transport is delivering someone else's events; a socket mismatch means it
 * is talking to a different (often dead) daemon for the same workspace; an
 * environment mismatch means it resolved a different `HOME`/data root entirely
 * and its own registry, db, and socket derivations all diverge from ours. They
 * share a symptom — silence — and nothing else, including their fixes.
 */
function bindingProblems(
  heartbeat: TransportHeartbeat,
  input: TransportHealthInput,
): TransportProblem[] {
  const problems: TransportProblem[] = [];
  const reconnect =
    'Restart the transport against this workspace: for the channel, start a ' +
    'new Claude Code session from this directory (or reconnect the MCP ' +
    'server) so it re-resolves `CLAUDE_PROJECT_DIR`; for hooks, the next ' +
    'prompt re-resolves automatically.';

  if (
    path.resolve(heartbeat.workspacePath) !== path.resolve(input.workspacePath)
  ) {
    problems.push({
      code: 'workspace-mismatch',
      detail:
        `The ${heartbeat.transport} transport for this host session is bound to ` +
        `workspace "${heartbeat.workspacePath}", but the monitors you are asking ` +
        `about live in "${input.workspacePath}". Events for this workspace are ` +
        `not being delivered to that session — it is listening somewhere else.`,
      remediation: reconnect,
    });
  } else if (heartbeat.socketPath !== input.socketPath) {
    // Only meaningful when the workspace matches: a different workspace
    // legitimately has a different socket, and reporting both would read as two
    // problems where there is one.
    problems.push({
      code: 'socket-mismatch',
      detail:
        `The ${heartbeat.transport} transport is bound to daemon socket ` +
        `"${heartbeat.socketPath}", but this workspace now resolves to ` +
        `"${input.socketPath}". It is polling a different (likely dead) daemon.`,
      remediation: reconnect,
    });
  }

  if (
    heartbeat.home !== input.expectedHome ||
    heartbeat.dataRoot !== input.expectedDataRoot
  ) {
    problems.push({
      code: 'environment-mismatch',
      detail:
        `The ${heartbeat.transport} transport resolved HOME="${heartbeat.home}" ` +
        `and data root "${heartbeat.dataRoot}", but this command resolves ` +
        `HOME="${input.expectedHome}" and "${input.expectedDataRoot}". The two ` +
        `are reading different databases and sockets, so neither can see the ` +
        `other's state.`,
      remediation: reconnect,
    });
  }

  return problems;
}

/**
 * Collect the currently-active reminder suppressions across every lead session.
 *
 * Reported once as a transport-level problem rather than per session: the guard
 * is a property of the delivery pipeline both transports share (`reserve` and
 * `claim` consult the same gate), so attributing it to one transport would
 * imply the other still works. It does not.
 */
function suppressionProblems(input: TransportHealthInput): TransportProblem[] {
  const suppressed = input.diagnoses.flatMap((diagnosis) =>
    diagnosis.holds
      .filter(
        (hold) =>
          hold.reason === 'coalesced-until-ack' ||
          hold.reason === 'already-claimed',
      )
      .map((hold) => ({ sessionId: diagnosis.sessionId, hold })),
  );
  if (suppressed.length === 0) return [];

  const sessions = [...new Set(suppressed.map((entry) => entry.sessionId))];
  const detail =
    `Delivery is up, but reminders are currently MUTED on ` +
    `${String(sessions.length)} lead session(s): ` +
    suppressed
      .map((entry) => `${entry.sessionId}: ${entry.hold.message}`)
      .join(' ');

  return [
    {
      code: 'reminders-suppressed',
      detail,
      remediation: sessions
        .map(
          (sessionId) =>
            `Acknowledge the claimed events so the reminder re-fires: \`agentmonitors events ack --session ${sessionId}\`.`,
        )
        .join(' '),
    },
  ];
}

/**
 * Report the sessions for which the suppression check itself could not be
 * run, rather than letting a skipped check read as "checked, nothing found".
 *
 * Reported once as a pipeline-wide problem (like {@link suppressionProblems}):
 * `hook.diagnose` failing is a property of the daemon connection, not of one
 * transport, so attributing it to a single transport row would wrongly imply
 * the other transport's suppression state was actually verified.
 */
function diagnosisUnavailableProblems(
  input: TransportHealthInput,
): TransportProblem[] {
  if (input.diagnosisUnavailableSessionIds.length === 0) return [];
  const sessions = input.diagnosisUnavailableSessionIds;
  return [
    {
      code: 'delivery-diagnosis-unavailable',
      detail:
        `Whether reminders are currently suppressed could not be determined ` +
        `for ${String(sessions.length)} lead session(s) (${sessions.join(', ')}): ` +
        `the daemon's delivery-diagnosis request failed (for example, an older ` +
        `daemon build that predates it). A suppression could be silently active, ` +
        `so this cannot be reported as deliverable.`,
      remediation:
        'Restart the daemon on the current CLI build (`agentmonitors daemon run` after stopping any older one), then re-run `agentmonitors doctor`.',
    },
  ];
}

/**
 * Pick the heartbeat that describes THIS session's transport.
 *
 * Selection order matters for detecting the misbinding case, but it must only
 * apply to a SESSION-SCOPED transport. `channel serve` is one long-lived
 * process per host session, so matching it by host session id **first, across
 * every workspace** is precisely what turns "my session's channel is
 * listening to another workspace" from an invisible absence into a reported
 * `workspace-mismatch`.
 *
 * `hook deliver`, by contrast, is a fresh short-lived process per PROMPT with
 * no stable per-session identity of its own — its record is keyed and
 * overwritten per WORKSPACE (see `heartbeatKey`), so any session's most recent
 * prompt in this workspace is a valid match for every lead session here. If
 * session-id-first matching were applied to it too, a session whose hook last
 * fired in workspace A — now leading workspace B, before its first prompt
 * there — would find no session match in B, fall through to a workspace match
 * that also fails (the record still says A), and report a false
 * `workspace-mismatch` with "restart the transport" — even though hooks
 * re-resolve on every prompt and self-heal with no action needed. So `hook`
 * always matches by workspace only; only `channel` tries session id first.
 */
function selectHeartbeat(
  transport: TransportName,
  input: TransportHealthInput,
): TransportHeartbeat | undefined {
  const candidates = input.heartbeats.filter(
    (heartbeat) => heartbeat.transport === transport,
  );
  const byWorkspace = candidates.filter(
    (heartbeat) =>
      path.resolve(heartbeat.workspacePath) ===
      path.resolve(input.workspacePath),
  );
  const pool =
    transport === 'channel'
      ? (() => {
          const sessionMatches = candidates.filter(
            (heartbeat) =>
              heartbeat.hostSessionId !== undefined &&
              input.leadHostSessionIds.includes(heartbeat.hostSessionId),
          );
          return sessionMatches.length > 0 ? sessionMatches : byWorkspace;
        })()
      : byWorkspace;
  // Most recently refreshed wins: with several sessions in one workspace, the
  // freshest record is the one whose health a user is actually asking about.
  return [...pool].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  )[0];
}

function buildTransport(
  transport: TransportName,
  input: TransportHealthInput,
  sharedProblems: readonly TransportProblem[],
): TransportStatus {
  const heartbeat = selectHeartbeat(transport, input);
  if (!heartbeat) {
    return {
      name: transport,
      configured: false,
      running: false,
      healthy: false,
      lastDelivery: null,
      problems: [],
    };
  }

  const stale = isHeartbeatStale(heartbeat, input.now);
  const problems: TransportProblem[] = [...bindingProblems(heartbeat, input)];

  if (stale) {
    problems.push({
      code: 'heartbeat-stale',
      detail:
        `The ${transport} transport last reported at ${heartbeat.updatedAt} ` +
        `(pid ${String(heartbeat.pid)}), beyond its ${String(heartbeat.ttlMs)}ms ` +
        `lease. It is presumed dead — a server killed without cleanup leaves ` +
        `exactly this trace.`,
      remediation:
        transport === 'channel'
          ? 'Reconnect the MCP server, or start a new Claude Code session in this workspace so `agentmonitors channel serve` is respawned.'
          : 'Submit a prompt in a Claude Code session in this workspace — the `UserPromptSubmit` hook re-runs `agentmonitors hook deliver` and refreshes this record. If it does not, the plugin hooks are not installed.',
    });
  }

  if (heartbeat.version !== input.cliVersion) {
    // Informational, not blocking (like `channel-registration-unverified`
    // below) — see the `blocking` filter. The hook transport's heartbeat
    // legitimately carries the PRE-upgrade version for up to its 24h TTL after
    // every CLI release (it only refreshes on the next prompt), so treating
    // this as a failure made `doctor` exit 1 for up to a day after every
    // single upgrade — the exact cry-wolf outcome issue #373 exists to
    // prevent, and directly contradicted the hook remediation's own "No
    // action needed" wording.
    problems.push({
      code: 'version-skew',
      detail:
        `The ${transport} transport is running @agentmonitors/cli ` +
        `${heartbeat.version} (${heartbeat.cliPath}), but this command is ` +
        `${input.cliVersion}. A long-lived transport keeps serving the build it ` +
        `started with, so a fix you just installed may not be in effect there. ` +
        `This is informational: delivery is not blocked by it.`,
      remediation:
        transport === 'channel'
          ? 'Start a new Claude Code session in this workspace so the channel server respawns on the current build.'
          : 'No action needed once the current build is on PATH — the next prompt spawns a fresh `hook deliver`.',
    });
  }

  if (transport === 'channel' && !stale) {
    // Not a defect we can observe: the host never tells the server whether its
    // `claude/channel` capability was honored, so a server outside the approved
    // allowlist (or started without the development-channels flag) connects
    // normally, resolves `notification()` normally, and has its events dropped
    // with no error. Report it as an explicitly-unverifiable caveat rather than
    // either asserting health we cannot prove or crying wolf about a problem
    // that is usually absent.
    problems.push({
      code: 'channel-registration-unverified',
      detail:
        'The channel server is connected, but whether the host actually ' +
        'registered it as a channel cannot be observed from this side: Claude ' +
        'Code drops channel events silently, with no error to the server, when ' +
        'the plugin is loaded as a plain MCP server. Confirm delivery end to ' +
        'end rather than trusting "connected".',
      remediation: `Prove it with \`agentmonitors verify <monitor>\`. If channel events never arrive, start the session with \`claude ${CHANNEL_DEV_FLAG}\` (or add the plugin to the approved channel allowlist); the hook transport keeps delivering meanwhile.`,
    });
  }

  // Shared problems are recorded on every configured transport so a consumer
  // reading `transports[].problems[]` alone — the shape the JSON contract
  // exposes — sees the reasons this transport cannot deliver, not just its own
  // defects. Renderers de-duplicate them via `isSharedProblem`.
  problems.push(...sharedProblems);

  const blocking = problems.filter(
    (problem) =>
      problem.code !== 'channel-registration-unverified' &&
      problem.code !== 'version-skew',
  );

  return {
    name: transport,
    configured: true,
    running: !stale,
    healthy: !stale && blocking.length === 0,
    boundTo: {
      workspacePath: heartbeat.workspacePath,
      socketPath: heartbeat.socketPath,
      home: heartbeat.home,
      dataRoot: heartbeat.dataRoot,
      pid: heartbeat.pid,
      cliPath: heartbeat.cliPath,
      ...(heartbeat.hostSessionId
        ? { hostSessionId: heartbeat.hostSessionId }
        : {}),
    },
    version: heartbeat.version,
    lastDelivery: heartbeat.lastDeliveryAt ?? null,
    problems,
  };
}

/**
 * Compute the delivery-transport health verdict for one workspace.
 *
 * Pure: every input is supplied by the caller, so each failure mode can be
 * constructed exactly in a test without a live daemon or MCP host.
 */
export function computeTransportHealth(
  input: TransportHealthInput,
): DeliveryTransportHealth {
  const sharedProblems: TransportProblem[] = [];
  if (!input.daemonRunning) sharedProblems.push(daemonProblem(input));
  sharedProblems.push(...suppressionProblems(input));
  sharedProblems.push(...diagnosisUnavailableProblems(input));

  const hook = buildTransport('hook', input, sharedProblems);
  const channel = buildTransport('channel', input, sharedProblems);
  const transports = [hook, channel];

  // A running heartbeat is not, on its own, an ACTIVE recipient (issue #425
  // review, round 3). `hook` is keyed per-workspace, not per-session, so a
  // fresh record left by a session that has since CLOSED still reads as
  // "running" for the rest of its 24h lease — and `channel`'s own session-id
  // match falls back to a workspace match (`selectHeartbeat` above) once
  // there are no live leads to match by session at all. Either way, a
  // transport can look perfectly healthy while there is nobody left for it to
  // deliver to. Gate `reach`/`deliverable` on there being at least one
  // currently-active lead host session (the caller supplies ACTIVE leads
  // only — see `doctor.ts`) before even asking which transport is listening.
  const hasActiveLead = input.leadHostSessionIds.length > 0;

  // A transport that is present and within its lease is *listening*, even if
  // the daemon behind it is down or its reminders are muted — those are
  // separate, separately-reported facts. Conflating them here is exactly the
  // "one generic unhealthy" collapse this surface exists to avoid.
  const listening = hasActiveLead
    ? transports.filter(
        (transport) =>
          transport.running &&
          !transport.problems.some(
            (problem) =>
              problem.code === 'workspace-mismatch' ||
              problem.code === 'environment-mismatch' ||
              problem.code === 'socket-mismatch',
          ),
      )
    : [];
  const reach: DeliveryReach = !hasActiveLead
    ? 'none'
    : listening.length === 2
      ? 'both'
      : (listening[0]?.name ?? 'none');

  const suppressed = sharedProblems.some(
    (problem) => problem.code === 'reminders-suppressed',
  );
  const diagnosisUnavailable = input.diagnosisUnavailableSessionIds.length > 0;
  const deliverable =
    hasActiveLead &&
    reach !== 'none' &&
    input.daemonRunning &&
    !suppressed &&
    !diagnosisUnavailable;

  const verdict = buildVerdict(
    reach,
    input,
    suppressed,
    diagnosisUnavailable,
    deliverable,
    hasActiveLead,
    transports,
  );

  // De-duplicate while preserving report order: several transports commonly
  // share one root cause (a down daemon), and repeating its fix reads as
  // multiple unrelated problems.
  const remediation = [
    ...new Set(
      [...sharedProblems, ...hook.problems, ...channel.problems].map(
        (problem) => problem.remediation,
      ),
    ),
  ];

  return {
    transports,
    pipelineProblems: sharedProblems,
    deliveryWillReachThisSession: reach,
    deliverable,
    verdict,
    remediation,
  };
}

function buildVerdict(
  reach: DeliveryReach,
  input: TransportHealthInput,
  suppressed: boolean,
  diagnosisUnavailable: boolean,
  deliverable: boolean,
  hasActiveLead: boolean,
  transports: readonly TransportStatus[],
): string {
  // Suppression is reported even when nothing is listening. The two are
  // independent problems that must BOTH be fixed before anything arrives, and
  // reporting only the absent transport would leave a reader who starts a
  // session still silently muted — the exact compounding failure this surface
  // exists to break.
  const mutedClause = suppressed
    ? ' Reminders are ALSO currently suppressed (coalesced-until-ack): acknowledge the claimed events, or nothing will surface even once a transport is listening.'
    : '';
  if (!hasActiveLead) {
    // Distinct from "no transport has reported in" below: a transport can be
    // configured and its heartbeat still fresh (`hook` is keyed per
    // WORKSPACE, not per session, so a session that closed minutes ago
    // leaves a record that outlives it for the rest of its 24h lease) while
    // there is genuinely no live session left for it to deliver to. Naming
    // that explicitly stops a reader from chasing a "fix the transport"
    // remediation for a problem that has nothing to do with the transport.
    const anyConfigured = transports.some((transport) => transport.configured);
    const base = anyConfigured
      ? 'delivery to THIS session → via none: there is no live session for this workspace — a transport has reported in previously, but no lead session is currently open for it to deliver to.'
      : 'delivery to THIS session → via none (no lead session is registered for this workspace; no transport has reported in).';
    return `${base}${mutedClause}`;
  }
  if (reach === 'none') {
    return `delivery to THIS session → via none: no delivery transport is listening for this workspace.${mutedClause}`;
  }
  const base = `delivery to THIS session → via ${reach}`;
  if (!input.daemonRunning) {
    return `${base}, but NOT deliverable: the daemon for this workspace is not running.`;
  }
  if (suppressed) {
    return `${base}, but NOT deliverable right now: reminders are suppressed (coalesced-until-ack) — new events will not surface until the claimed ones are acknowledged.`;
  }
  if (diagnosisUnavailable) {
    return `${base}, but NOT deliverable: whether reminders are suppressed could not be determined (the daemon's delivery-diagnosis request failed) — see the problems above.`;
  }
  return deliverable
    ? `${base} (healthy).`
    : `${base}, but NOT deliverable: see the problems above.`;
}
