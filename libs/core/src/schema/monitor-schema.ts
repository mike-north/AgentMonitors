import { z } from 'zod';

const durationPattern = /^\d+[smhd]$/;

const debounceNotifySchema = z.object({
  strategy: z.literal('debounce'),
  'settle-for': z
    .string()
    .regex(
      durationPattern,
      'Must be a duration string (e.g., "5m", "30s", "1h")',
    ),
});

const throttleNotifySchema = z.object({
  strategy: z.literal('throttle'),
  'suppress-for': z
    .string()
    .regex(
      durationPattern,
      'Must be a duration string (e.g., "5m", "30s", "1h")',
    ),
});

// A five-field cron expression (minute hour day month weekday) — the same
// grammar the `schedule` source accepts for `cron`. We validate only the
// field count here (cheap, structural); individual field grammar is evaluated
// at runtime by `cronMatchesDate` (a malformed field simply never matches),
// matching how the schedule source treats `scope.cron`. See 001 §3.6.
const cronPattern = /^\s*\S+(?:\s+\S+){4}\s*$/;

/**
 * The third Pace mode (G12 / 001 §3.6, 002 §4.4): the runtime accumulates
 * observations between delivery windows and flushes them as a single composite
 * delivery when the author's `window` cron next fires. `window` is required —
 * a `rollup` strategy without a delivery schedule has no flush trigger, so it
 * is rejected by `validate` (proof criterion (a)).
 */
const rollupNotifySchema = z.object({
  strategy: z.literal('rollup'),
  window: z
    .string()
    .regex(
      cronPattern,
      'Must be a five-field cron expression (e.g., "0 9 * * 1-5")',
    ),
  timezone: z.string().min(1).optional(),
});

const notifySchema = z.discriminatedUnion('strategy', [
  debounceNotifySchema,
  throttleNotifySchema,
  rollupNotifySchema,
]);

/**
 * The two author-declared baseline strategies for the per-recipient Diff stage.
 *
 * - `incremental` (**default**) — every observation in a recipient's catch-up
 *   span is delivered in order (play-by-play). A recipient that missed _N_
 *   shaped observations receives _N_ deltas. This is the closest equivalent of
 *   today's runtime behavior (one event per materialized observation), so it
 *   preserves full backward compatibility.
 * - `net` — the catch-up span is collapsed into a **single net delta** (the
 *   shaped state at the delivery point versus the recipient's baseline);
 *   intermediate observations are discarded.
 *
 * Omitting `baseline-strategy` entirely is equivalent to `incremental`.
 *
 * @see docs/specs/001-monitor-definition.md §3.7
 * @see docs/specs/002-runtime-delivery.md §1.1.7
 */
const baselineStrategyValues = ['incremental', 'net'] as const;

const baselineStrategySchema = z
  .enum(baselineStrategyValues)
  .default('incremental');

const urgencyLevels = ['low', 'normal', 'high'] as const;
const urgencyRank: Record<(typeof urgencyLevels)[number], number> = {
  low: 0,
  normal: 1,
  high: 2,
};

/**
 * The authored `urgency` frontmatter value. It is a **band** the runtime is
 * allowed to deliver within:
 *
 * - A bare scalar (`urgency: normal`) is the degenerate band `normal..normal` —
 *   a per-observation `salience` can never escalate it (full backward compat).
 * - A range (`urgency: normal..high`) authorizes source `salience` to escalate
 *   the effective urgency anywhere from the low bound up to the high bound; a
 *   `salience` outside the band is clamped to the nearest bound.
 *
 * Escalation is therefore always an explicit, visible authorial grant: the
 * runtime only escalates within a band the monitor author wrote (PP5 — urgency
 * stays user-controlled).
 *
 * Parses to `{ urgency, urgencyMax }` where `urgency` is the band's low bound
 * (the base/default effective urgency used when no `salience` is present, kept
 * under the `urgency` key for backward compatibility with every existing
 * consumer) and `urgencyMax` is the band's high bound (equal to `urgency` for a
 * scalar). Reject an inverted/invalid range (`lo` must be ≤ `hi`).
 *
 * @see docs/specs/001-monitor-definition.md §3.2
 */
const urgencyBandSchema = z.string().transform((raw, ctx) => {
  const text = raw.trim();
  const parts = text.includes('..')
    ? text.split('..').map((part) => part.trim())
    : [text, text];

  if (parts.length !== 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'urgency must be a single level (e.g. "normal") or a range "lo..hi" (e.g. "normal..high")',
    });
    return z.NEVER;
  }

  const [loRaw, hiRaw] = parts;
  const isLevel = (
    value: string | undefined,
  ): value is (typeof urgencyLevels)[number] =>
    value !== undefined && (urgencyLevels as readonly string[]).includes(value);

  if (!isLevel(loRaw) || !isLevel(hiRaw)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `urgency bounds must each be one of ${urgencyLevels
        .map((level) => `"${level}"`)
        .join(', ')}`,
    });
    return z.NEVER;
  }

  if (urgencyRank[loRaw] > urgencyRank[hiRaw]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `range "${loRaw}..${hiRaw}" is inverted — the low bound must not exceed the high bound`,
    });
    return z.NEVER;
  }

  return { lo: loRaw, hi: hiRaw };
});

/**
 * The `watch` block — an intent-first, discriminated description of what to
 * observe. `type` names the observation source (kebab-case, matches a source
 * plugin name); the remaining keys are per-source configuration carried flat
 * alongside `type`.
 */
const watchSchema = z
  .object({
    type: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, 'watch.type must be kebab-case'),
  })
  .catchall(z.unknown());

export const monitorFrontmatterSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Monitor name must be non-empty when present')
      .optional(),
    watch: watchSchema,
    urgency: urgencyBandSchema,
    notify: notifySchema.optional(),
    // Author-declared baseline strategy for the per-recipient Diff stage. The
    // YAML key is kebab-case (`baseline-strategy`); it is renamed to the
    // camelCase `baselineStrategy` in the transform below so consumers read a
    // stable, defaulted value. Omitting the field yields `incremental` (the
    // `.default()`), which is backward compatible. An unknown value (anything
    // other than `incremental`/`net`) is rejected by the enum. See 001 §3.7 /
    // 002 §1.1.7.
    'baseline-strategy': baselineStrategySchema,
    tags: z.array(z.string()).optional(),
  })
  .transform(({ urgency, 'baseline-strategy': baselineStrategy, ...rest }) => ({
    ...rest,
    // Surface the defaulted, validated baseline strategy under a camelCase key
    // (002 §1.1.7). `incremental` when the author omitted the field.
    baselineStrategy,
    // Flatten the parsed band: `urgency` is the band's low bound — the base /
    // default effective urgency used when no source `salience` is present (kept
    // under this key for backward compatibility with every existing consumer) —
    // and `urgencyMax` is the band's high bound (equal to `urgency` for a
    // scalar). Source salience may escalate the effective urgency between these
    // two, clamping outside the band. See 002 §4.1 / 003 §2.3.
    urgency: urgency.lo,
    urgencyMax: urgency.hi,
  }));

export type MonitorFrontmatter = z.infer<typeof monitorFrontmatterSchema>;
export type NotifyConfig = z.infer<typeof notifySchema>;

/**
 * The author-declared per-recipient Diff baseline strategy (001 §3.7,
 * 002 §1.1.7). `incremental` is the default and backward-compatible behavior.
 */
export type BaselineStrategy = (typeof baselineStrategyValues)[number];

export {
  notifySchema,
  debounceNotifySchema,
  throttleNotifySchema,
  rollupNotifySchema,
};
