/**
 * Result model and renderers for `agentmonitors verify`. Kept separate from the
 * orchestration (`commands/verify.ts`) so the PASS/FAIL rendering — the
 * user-facing contract (issue #399) — is pure and unit-testable without booting
 * a daemon.
 */

/** A named end-to-end stage in the verify pipeline. */
export type StageName =
  | 'daemon'
  | 'session'
  | 'baseline'
  | 'trigger'
  | 'observe'
  | 'materialize'
  | 'deliver';

export type StageStatus = 'pass' | 'fail' | 'pending' | 'skip';

export interface Stage {
  name: StageName;
  status: StageStatus;
  detail: string;
}

/**
 * Why a verify run failed, distinguishing the states the manual recipe collapsed
 * into an ambiguous empty result (issue #399 criterion 4):
 * - `no-change` / `no-files-matched` — the trigger did nothing (fix the trigger).
 * - `budget-exceeded` — detected but never delivered within the interval budget.
 * - `daemon-died` — the daemon crashed mid-run (surface its own error, #398).
 * - `delivery-empty` — event materialized but the claim surfaced nothing.
 * - `setup` — could not even start (monitor not found, boot failure, …).
 */
export type FailureKind =
  | 'no-change'
  | 'no-files-matched'
  | 'budget-exceeded'
  | 'daemon-died'
  | 'delivery-empty'
  | 'setup';

/**
 * The workspace's channel route, read-only, from the channel heartbeats (006
 * §4.5.2). verify never pushes on the host channel — it proves delivery
 * through an isolated session — so its own PASS says nothing about this.
 */
export type VerifyChannelRoute = 'not-running' | 'unproven' | 'confirmed';

export interface VerifyResult {
  ok: boolean;
  /** Omitted when the route was not read (e.g. a setup failure). */
  channelRoute?: VerifyChannelRoute;
  monitorId: string;
  stages: Stage[];
  failure?: { kind: FailureKind; message: string };
  additionalContext?: string;
  daemonStderr?: string;
  elapsedMs: number;
}

const CHANNEL_ROUTE_TEXT: Record<VerifyChannelRoute, string> = {
  'not-running': 'not running (hooks deliver)',
  unproven: 'unproven (no push confirmed by the host; hooks deliver)',
  confirmed: 'confirmed (the host confirmed a push in this channel process)',
};

const STATUS_GLYPH: Record<StageStatus, string> = {
  pass: '✓',
  fail: '✗',
  pending: '⏳',
  skip: '○',
};

/**
 * Render the human-readable PASS/FAIL report. On PASS, echoes the delivered
 * `additionalContext` (the proof artifact); on FAIL, names the failing stage and
 * — for a `daemon-died` failure — surfaces the daemon's own captured output.
 */
export function renderVerifyText(result: VerifyResult): string {
  const lines: string[] = [];
  lines.push(`agentmonitors verify: ${result.monitorId}`);
  lines.push('');
  for (const stage of result.stages) {
    lines.push(
      `  ${STATUS_GLYPH[stage.status]} ${stage.name.padEnd(11)} ${stage.detail}`,
    );
  }
  lines.push('');
  const seconds = (result.elapsedMs / 1000).toFixed(1);
  if (result.ok) {
    lines.push(`PASS  ${result.monitorId} delivers end-to-end (${seconds}s)`);
    if (result.additionalContext) {
      lines.push('');
      lines.push('Delivered additionalContext:');
      for (const line of result.additionalContext.split('\n')) {
        lines.push(`  ${line}`);
      }
    }
  }
  if (!result.ok && result.failure) {
    const failedStage = result.stages.find((stage) => stage.status === 'fail');
    lines.push(
      `FAIL  ${failedStage ? `${failedStage.name} — ` : ''}${result.failure.message}`,
    );
    if (result.daemonStderr && result.daemonStderr.trim().length > 0) {
      lines.push('');
      lines.push('Daemon output:');
      for (const line of result.daemonStderr.trimEnd().split('\n')) {
        lines.push(`  ${line}`);
      }
    }
  }
  if (result.channelRoute) {
    // verify proves delivery through an isolated session, never through the
    // host channel, so its PASS must not be read as channel health (006 §4.5.2).
    lines.push('');
    lines.push(
      `Channel route: ${CHANNEL_ROUTE_TEXT[result.channelRoute]}.` +
        (result.ok
          ? ' This pass does not by itself prove the channel route.'
          : ''),
    );
  }
  return lines.join('\n');
}

/** Render the stable machine-readable shape (spec 005 §16). */
export function renderVerifyJson(result: VerifyResult): string {
  return JSON.stringify(
    {
      ok: result.ok,
      monitorId: result.monitorId,
      stages: result.stages,
      failure: result.failure ?? null,
      channelRoute: result.channelRoute ?? null,
      additionalContext: result.additionalContext ?? null,
      daemonStderr: result.daemonStderr ?? null,
      elapsedMs: result.elapsedMs,
    },
    null,
    2,
  );
}
