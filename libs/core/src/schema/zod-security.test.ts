/** Verifies the collection-bound primitive used at validation boundaries rejects
 * oversized collections before executing element validators (GHSA-mrhx-c7xc-m3w5).
 */
import { expect, it } from 'vitest';
import { z } from 'zod';

it('rejects an oversized bounded array without visiting its elements', () => {
  let visits = 0;
  const schema = z
    .array(
      z.preprocess((value) => {
        visits += 1;
        return value;
      }, z.string()),
    )
    .max(2);
  const result = schema.safeParse([1, 2, 3]);
  expect(result.success).toBe(false);
  expect(visits).toBe(0);
  if (!result.success) expect(result.error.issues).toHaveLength(1);
});
