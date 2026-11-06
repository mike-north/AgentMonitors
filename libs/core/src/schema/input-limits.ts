/**
 * Admission budgets for authored monitors. These cap work before validation
 * visits elements or compiles predicates; output truncation cannot do that.
 * They are deliberately generous for human-authored configuration, not limits
 * on observations or delivered payloads.
 */
import { z } from 'zod';

/** Maximum UTF-8 file size, including instructions, admitted to YAML parsing. @internal */
export const MAX_MONITOR_BYTES = 1024 * 1024;
/** Tags classify a monitor; hundreds already exceed typical classification needs. @internal */
export const MAX_MONITOR_TAGS = 256;
/** Each derive rule compiles and evaluates a predicate, so it has a tighter budget. @internal */
export const MAX_MONITOR_DERIVE_RULES = 128;

/**
 * Reject the collection as a whole before Zod can visit any element. A plain
 * array `.max()` was insufficient on Zod 3, which validated elements first.
 * Keep admission explicit on Zod 4 so collection-level rejection remains
 * independent of element or predicate validation. The declaration itself must
 * be a raw array: reject non-arrays before returning from preprocessing, which
 * otherwise unwraps native Promises during async parsing (or throws in sync
 * parsing). Resolved arrays are not an additional authoring format.
 * @internal
 */
export function boundedMonitorArray<T extends z.ZodType>(
  element: T,
  maximum: number,
) {
  return z.preprocess((value, ctx): unknown => {
    if (!Array.isArray(value)) {
      ctx.addIssue({ code: 'invalid_type', expected: 'array', input: value });
      return z.NEVER;
    }
    if (value.length > maximum) {
      ctx.addIssue({
        code: 'custom',
        message: `INPUT_LIMIT_EXCEEDED: collection must contain at most ${String(maximum)} entries`,
        params: { inputLimit: true },
        fatal: true,
      });
      return z.NEVER;
    }
    return value;
  }, z.array(element));
}
