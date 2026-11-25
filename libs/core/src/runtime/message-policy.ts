import { z } from 'zod';
import type { MessageState } from './types.js';

/** A path separator keeps this identity distinct from authored monitor basenames. */
export const POST_MONITOR_ID = 'message/post';

export const postMessageInputSchema = z
  .object({
    sessionId: z.string().min(1),
    body: z
      .string()
      .max(16_384)
      .refine((body) => body.trim().length > 0, {
        message: 'Message body must contain text.',
      }),
    key: z.string().min(1).optional(),
    requireAck: z.boolean().optional(),
    resurfaceAfterMs: z.number().int().min(1).max(2_147_483_647).optional(),
    maxResurfaces: z.number().int().min(0).max(100).optional(),
  })
  .superRefine((input, ctx) => {
    if (
      !input.requireAck &&
      (input.resurfaceAfterMs !== undefined ||
        input.maxResurfaces !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Resurfacing options require acknowledgement.',
      });
    }
  });

export function messageStateForProjection(
  row: {
    messageRetryMs: number | null;
    messageMaxResurfaces: number;
    messageClaims: number;
    messageDueAtMs: number | null;
    acknowledgedAt: Date | null;
  },
  nowMs: number,
): MessageState | undefined {
  if (row.messageRetryMs === null) return undefined;
  if (row.acknowledgedAt) return 'acked';
  if (row.messageClaims === 0) return 'pending';
  if (
    row.messageRetryMs > 0 &&
    (row.messageClaims > row.messageMaxResurfaces + 1 ||
      (row.messageClaims === row.messageMaxResurfaces + 1 &&
        row.messageDueAtMs !== null &&
        row.messageDueAtMs <= nowMs))
  )
    return 'needs-attention';
  return row.messageClaims === 1 ? 'delivered' : 'resurfaced';
}
