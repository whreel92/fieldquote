/**
 * Hand-authored zod schemas for values shared across apps.
 * API request/response types come from api.gen.ts (generated — do not edit).
 */

import { z } from 'zod';

export const jobStatusSchema = z.enum([
  'lead',
  'estimating',
  'sent',
  'won',
  'lost',
  'in_progress',
  'complete',
  'paid',
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const userRoleSchema = z.enum(['owner', 'admin', 'tech', 'office']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const captureKindSchema = z.enum(['photo', 'audio']);
export type CaptureKind = z.infer<typeof captureKindSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).default({}),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
