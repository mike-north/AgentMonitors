/**
 * The host-agnostic **Interpret adapter** boundary (G14,
 * [002 §1.1.8](../../../../docs/specs/002-runtime-delivery.md#118-interpret-a-cheap-agentic-digest-via-the-users-own-ai-tool),
 * [006 §2.1](../../../../docs/specs/006-agent-integration.md#21-the-interpret-adapter-is-upstream-of-transports-not-a-transport)).
 *
 * The optional Interpret stage produces a cheap, natural-language digest of a
 * **per-recipient delta** and, optionally, applies an agentic significance gate
 * (suppress-if-not-substantive). It is the one stage that invokes an AI model.
 *
 * Per the host-agnostic-core invariant (AP3,
 * [002 §11.1](../../../../docs/specs/002-runtime-delivery.md#111-the-agentruntimeadapter-contract)),
 * **which** AI tool to invoke, the command string, and how to pass the delta in /
 * read the digest out are **host-specific** and live behind this adapter — never
 * in the runtime core (`libs/core/src/runtime/`). The runtime core owns _when_
 * Interpret runs (after Diff, before Deliver), _whether_ it runs (the `prose`
 * gate), and the recording of its decision; an adapter owns _how_ the user's tool
 * is invoked.
 *
 * **Agent Monitors ships no model and holds no credentials** (C45): the concrete
 * adapter shells out to whatever AI CLI the user already has installed (e.g.
 * `claude -p …`), so the deployment inherits the user's existing data-governance
 * and egress posture by construction.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.8
 * @see ../../../../docs/specs/006-agent-integration.md §2.1
 */
import { execFile } from 'node:child_process';

/**
 * The input to one Interpret invocation: the per-recipient delta plus the
 * author-declared criteria the model judges the change against. Interpret is a
 * pure function of `(delta, author criteria)` and **MUST NOT** depend on the
 * receiving agent's private runtime context (002 §1.1.8).
 */
export interface InterpretInput {
  /**
   * The per-recipient delta to read — _what is new for this recipient_ (the
   * output of the per-recipient Diff). Never the raw source snapshot, never the
   * whole shared artifact (002 §1.1.8).
   */
  readonly delta: string;
  /**
   * Author-supplied criteria and reference data the model classifies the delta
   * against (e.g. "is this a question I must answer?"). Drawn from the monitor
   * definition, not the recipient's private state.
   */
  readonly criteria?: string | undefined;
  /** The monitor id, for the adapter's prompt context and logging. */
  readonly monitorId: string;
}

/**
 * The verdict of one Interpret invocation. Either a `deliver` decision carrying
 * the cheap digest to surface, or a `suppress` decision carrying the reason the
 * agentic significance gate fired (recorded as explainable, never a silent drop).
 */
export type InterpretResult =
  | {
      readonly decision: 'deliver';
      /** The cheap, natural-language digest of the delta, sized to the span. */
      readonly digest: string;
    }
  | {
      readonly decision: 'suppress';
      /**
       * Why the agentic gate judged the change not substantive (recorded on the
       * per-recipient surface and surfaced via `monitor explain`, 002 §10.7).
       */
      readonly reason: string;
    };

/**
 * The Interpret adapter contract. A new host that wires a different AI CLI is a
 * new adapter, not a change to the runtime core.
 */
export interface InterpretAdapter {
  /** Unique identifier for the adapter. */
  readonly name: string;
  /**
   * Invoke the user's own AI tool to read the delta and produce a digest +
   * significance verdict. Rejecting (tool missing / errors / times out) is a
   * best-effort failure the runtime falls back from (002 §1.1.8) — it MUST NOT
   * drop the underlying delta.
   */
  interpret(input: InterpretInput): Promise<InterpretResult>;
}

/** Options for {@link createClaudeInterpretAdapter}. */
export interface ClaudeInterpretAdapterOptions {
  /**
   * The AI CLI binary to shell out to. Defaults to `claude`. Agent Monitors
   * ships no model — this resolves to the user's own installed tool.
   */
  readonly command?: string;
  /** Max time (ms) to wait for the tool before treating it as a failure. */
  readonly timeoutMs?: number;
}

const DEFAULT_INTERPRET_TIMEOUT_MS = 30_000;

/**
 * Build the prompt handed to the user's AI tool. The tool is asked to either
 * suppress (when the delta is not substantive against the criteria) or deliver a
 * one-line digest sized to the span, and to answer in a machine-readable form the
 * adapter can parse deterministically.
 */
function buildPrompt(input: InterpretInput): string {
  const criteria =
    input.criteria && input.criteria.trim().length > 0
      ? input.criteria.trim()
      : 'Summarize the change if it is substantive; otherwise suppress it.';
  return [
    `You are reading the change observed by monitor "${input.monitorId}".`,
    '',
    'Author criteria:',
    criteria,
    '',
    'The change (delta):',
    input.delta,
    '',
    'If the change is NOT substantive against the criteria, reply with exactly:',
    'SUPPRESS: <one short reason>',
    'Otherwise reply with exactly:',
    'DELIVER: <one-line digest of the change>',
  ].join('\n');
}

/**
 * Parse the tool's stdout into an {@link InterpretResult}. A response that does
 * not match the `SUPPRESS:`/`DELIVER:` contract is treated as a `deliver` with
 * the raw output as the digest — the safe default is to surface the change, never
 * to silently drop it.
 */
function parseToolOutput(stdout: string): InterpretResult {
  const text = stdout.trim();
  const suppressMatch = /^SUPPRESS:\s*(.*)$/is.exec(text);
  if (suppressMatch) {
    const reason = suppressMatch[1]?.trim();
    return {
      decision: 'suppress',
      reason: reason && reason.length > 0 ? reason : 'not substantive',
    };
  }
  const deliverMatch = /^DELIVER:\s*([\s\S]*)$/i.exec(text);
  const digest = deliverMatch?.[1]?.trim() ?? text;
  return { decision: 'deliver', digest: digest.length > 0 ? digest : text };
}

/**
 * The concrete Interpret adapter that shells out to the user's own `claude -p`
 * CLI (or another AI CLI named by `options.command`). This is the host-specific
 * invocation that 002 §1.1.8 / 006 §2.1 require to live behind the adapter
 * boundary — **never** in the runtime core.
 *
 * Agent Monitors holds no credentials and ships no model: the tool runs as the
 * user, inheriting their data-governance and egress posture. If the tool is not
 * installed it rejects, and the runtime falls back to the deterministic
 * `rendered` artifact (best-effort, 002 §1.1.8).
 */
export function createClaudeInterpretAdapter(
  options: ClaudeInterpretAdapterOptions = {},
): InterpretAdapter {
  const command = options.command ?? 'claude';
  const timeoutMs = options.timeoutMs ?? DEFAULT_INTERPRET_TIMEOUT_MS;
  return {
    name: 'claude-interpret',
    interpret(input: InterpretInput): Promise<InterpretResult> {
      const prompt = buildPrompt(input);
      return new Promise<InterpretResult>((resolve, reject) => {
        // `-p` is Claude Code's non-interactive print mode. argv-only, never a
        // shell, so the delta/prompt can never be interpreted as shell syntax.
        execFile(
          command,
          ['-p', prompt],
          { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
          (error, stdout) => {
            // `execFile` surfaces an `Error` (or `null`) here — a tool that is
            // missing, errors, or times out rejects, and the runtime falls back
            // to the deterministic artifact (best-effort, 002 §1.1.8).
            if (error) {
              reject(
                error instanceof Error ? error : new Error('Interpret failed'),
              );
              return;
            }
            resolve(parseToolOutput(stdout));
          },
        );
      });
    },
  };
}
