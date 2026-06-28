import { z } from 'zod';
import { validateCelPredicate } from '../runtime/shape.js';
import {
  validatePayloadTransform,
  type TransformLanguage,
} from '../runtime/transform.js';

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
  timezone: z
    .string()
    .min(1)
    .refine(
      (tz) => {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      },
      {
        message:
          'Must be a valid IANA time zone name (e.g., "America/New_York", "UTC")',
      },
    )
    .optional(),
});

const notifySchema = z.discriminatedUnion('strategy', [
  debounceNotifySchema,
  throttleNotifySchema,
  rollupNotifySchema,
]);

/**
 * The two author-declared baseline strategies for the per-recipient Diff stage.
 *
 * - `net` (**default**) — the catch-up span is collapsed into a **single net
 *   delta** (the shaped state at the delivery point versus the recipient's
 *   baseline); intermediate observations between delivery windows are absorbed.
 *   A recipient that missed _N_ shaped observations receives **one** delta
 *   (where things stand now vs. their baseline). This is the standard
 *   delivery contract (2026-06-19 decision, Refs #110).
 * - `incremental` — every observation in a recipient's catch-up span is
 *   delivered in order (play-by-play). A recipient that missed _N_ shaped
 *   observations receives _N_ deltas. Use when the _sequence_ of changes
 *   matters (e.g. comment threads where each reply is a discrete step).
 *
 * Omitting `baseline-strategy` entirely is equivalent to `net`.
 *
 * @see docs/specs/001-monitor-definition.md §3.7
 * @see docs/specs/002-runtime-delivery.md §1.1.7
 */
const baselineStrategyValues = ['incremental', 'net'] as const;

const baselineStrategySchema = z.enum(baselineStrategyValues).default('net');

const urgencyLevels = ['low', 'normal', 'high'] as const;
const urgencyRank: Record<(typeof urgencyLevels)[number], number> = {
  low: 0,
  normal: 1,
  high: 2,
};

const DEFAULT_URGENCY_BAND = { lo: 'normal', hi: 'normal' } as const;

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

/**
 * The deterministic **Shape** declaration ([001 §5.1](../../docs/specs/001-monitor-definition.md#51-shape-declaration-target)).
 *
 * `derive` is an ordered list of named derived facts; each `when` is a CEL
 * boolean predicate over `(snapshot, now)`. `render` opts into rendering the
 * shaped state to the diffable artifact ([002 §1.1.5](../../docs/specs/002-runtime-delivery.md#115-shape-render-to-a-stable-artifact-then-diff-the-artifact)).
 * A malformed CEL predicate is rejected (determinism is a validation obligation,
 * [004 §2.2](../../docs/specs/004-validation-testing.md)).
 */
const deriveRuleSchema = z.object({
  name: z.string().min(1, 'shape.derive[].name must be non-empty'),
  when: z.string().min(1, 'shape.derive[].when must be a CEL predicate'),
});

const shapeSchema = z
  .object({
    derive: z.array(deriveRuleSchema).optional(),
    render: z.literal('rendered').optional(),
  })
  .superRefine((shape, ctx) => {
    for (const [index, rule] of (shape.derive ?? []).entries()) {
      const error = validateCelPredicate(rule.when);
      if (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['derive', index, 'when'],
          message: `malformed CEL predicate: ${error}`,
        });
      }
    }
  });

const transformLanguages = ['jq', 'cel'] as const satisfies readonly [
  TransformLanguage,
  TransformLanguage,
];

/**
 * The author-declared payload **form** — one of `prose`, `structured`,
 * `artifact`, `rendered` ([001 §5.2](../../docs/specs/001-monitor-definition.md#52-payload-form-target),
 * [002 §1.1.6](../../docs/specs/002-runtime-delivery.md#116-author-declared-payload-form)).
 *
 * This is a **stable contract** the follow-on Interpret stage (G14) builds on:
 * the `prose` form is the one form that invokes Interpret; `structured`,
 * `artifact`, and `rendered` are the deterministic-floor forms. Authored as an
 * explicit union (not a derived alias) so the contract is hand-pinned.
 */
export type PayloadForm = 'prose' | 'structured' | 'artifact' | 'rendered';

/** The output serialization for a `structured` payload (`json` default). */
export type PayloadEncoding = 'json' | 'yaml' | 'toon' | 'toml';

const payloadForms = [
  'prose',
  'structured',
  'artifact',
  'rendered',
] as const satisfies readonly PayloadForm[];
const payloadEncodings = [
  'json',
  'yaml',
  'toon',
  'toml',
] as const satisfies readonly PayloadEncoding[];

const payloadFormSchema = z.enum(payloadForms);
const payloadEncodingSchema = z.enum(payloadEncodings);

const payloadTransformSchema = z.object({
  language: z.enum(transformLanguages),
  expression: z
    .string()
    .min(1, 'payload.transform.expression must be non-empty'),
});

/**
 * The author-declared **payload form** ([001 §5.2](../../docs/specs/001-monitor-definition.md#52-payload-form-target)).
 *
 * `form` is one of `prose | structured | artifact | rendered`. A `transform` is
 * valid **only** under `form: structured`; a malformed `jq`/`cel` expression is
 * rejected. `encoding` is a downstream serialization concern.
 */
const payloadSchema = z
  .object({
    form: payloadFormSchema,
    transform: payloadTransformSchema.optional(),
    encoding: payloadEncodingSchema.optional(),
  })
  .superRefine((payload, ctx) => {
    if (payload.transform && payload.form !== 'structured') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transform'],
        message:
          'payload.transform is only valid when payload.form is "structured"',
      });
      return;
    }
    if (payload.transform) {
      const error = validatePayloadTransform(payload.transform);
      if (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['transform', 'expression'],
          message: `malformed ${payload.transform.language} transform: ${error}`,
        });
      }
    }
  });

export const monitorFrontmatterSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Monitor name must be non-empty when present')
      .optional(),
    watch: watchSchema,
    // Optional: an omitted `urgency` defaults to the degenerate band
    // `normal..normal` (see the transform below). Keeping the simplest monitor to
    // `watch:` + body is the gradual-reveal floor; an author opts into `high`
    // (interrupt) or a `lo..hi` escalation band only when they need it (PP5 — the
    // default never escalates on its own). 001 §3.2.
    urgency: urgencyBandSchema.optional(),
    notify: notifySchema.optional(),
    // Author-declared baseline strategy for the per-recipient Diff stage. The
    // YAML key is kebab-case (`baseline-strategy`); it is renamed to the
    // camelCase `baselineStrategy` in the transform below so consumers read a
    // stable, defaulted value. Omitting the field yields `net` (the
    // `.default()`), the standard per-object consolidation behavior (2026-06-19
    // decision, Refs #110, 001 §3.7 / 002 §1.1.7). An unknown value (anything
    // other than `incremental`/`net`) is rejected by the enum.
    'baseline-strategy': baselineStrategySchema,
    tags: z.array(z.string()).optional(),
    shape: shapeSchema.optional(),
    payload: payloadSchema.optional(),
  })
  .transform(({ urgency, 'baseline-strategy': baselineStrategy, ...rest }) => ({
    ...rest,
    // Surface the defaulted, validated baseline strategy under a camelCase key
    // (002 §1.1.7). `net` when the author omitted the field (default since
    // 2026-06-19, Refs #110).
    baselineStrategy,
    // Flatten the parsed band: `urgency` is the band's low bound — the base /
    // default effective urgency used when no source `salience` is present (kept
    // under this key for backward compatibility with every existing consumer) —
    // and `urgencyMax` is the band's high bound (equal to `urgency` for a
    // scalar). Source salience may escalate the effective urgency between these
    // two, clamping outside the band. See 002 §4.1 / 003 §2.3.
    //
    // An omitted `urgency` defaults to the degenerate band `normal..normal`, so
    // the minimal monitor (`watch:` + body) is valid and delivers at `normal`.
    urgency: (urgency ?? DEFAULT_URGENCY_BAND).lo,
    urgencyMax: (urgency ?? DEFAULT_URGENCY_BAND).hi,
  }));

export type MonitorFrontmatter = z.infer<typeof monitorFrontmatterSchema>;
export type NotifyConfig = z.infer<typeof notifySchema>;

/**
 * The author-declared per-recipient Diff baseline strategy (001 §3.7,
 * 002 §1.1.7). `incremental` is the default and backward-compatible behavior.
 */
export type BaselineStrategy = (typeof baselineStrategyValues)[number];

/**
 * The parsed `shape` frontmatter block ([001 §5.1](../../docs/specs/001-monitor-definition.md#51-shape-declaration-current)).
 */
export type ShapeConfig = z.infer<typeof shapeSchema>;

/**
 * The parsed `payload` frontmatter block ([001 §5.2](../../docs/specs/001-monitor-definition.md#52-payload-form-current)).
 */
export type PayloadConfig = z.infer<typeof payloadSchema>;

export {
  notifySchema,
  debounceNotifySchema,
  throttleNotifySchema,
  rollupNotifySchema,
};
export { shapeSchema, payloadSchema };
