import { z } from 'zod';

export const VoiceSessionCreateSchema = z.object({ conversationId: z.string().uuid().optional(), clientPlayback: z.boolean().optional() }).strict();
export const VoicePlaybackStopSchema = z.object({}).strict();
export const VoiceInterruptDiagnosticSchema = z.object({
  reason: z.enum(['manual', 'speech', 'stop_command', 'manual_only', 'aec_unavailable', 'no_text', 'echo', 'insufficient_speech', 'device']),
  durationMs: z.number().min(0).max(10000), level: z.number().min(0).max(1), noise: z.number().min(0).max(1),
  echoCancellation: z.boolean(), playing: z.boolean(),
}).strict();
export type VoiceInterruptDiagnostic = z.infer<typeof VoiceInterruptDiagnosticSchema>;
export const RealtimeVoiceInterruptSchema = z.object({
  session_id: z.string().regex(/^[a-f0-9]{32}$/),
  responseEpoch: z.number().int().nonnegative().optional(),
  diagnostic: VoiceInterruptDiagnosticSchema.optional(),
}).strict();
export const RealtimeVoicePlaybackSchema = RealtimeVoiceInterruptSchema.extend({
  responseEpoch: z.number().int().nonnegative(), busy: z.boolean(),
}).strict();
export const RealtimeVoiceDiagnosticSchema = RealtimeVoiceInterruptSchema.omit({ responseEpoch: true }).extend({ diagnostic: VoiceInterruptDiagnosticSchema }).strict();

export const VoiceWorkStartSchema = z.object({
  objective: z.string().trim().min(1).max(4_000),
  employeeId: z.string().trim().min(1).max(160).optional(),
  assetIds:z.array(z.string().uuid()).max(5).optional(),
}).strict();
export const VoiceWorkTaskSchema = z.object({ taskId: z.string().uuid() }).strict();
export const VoiceWorkBindingSchema = z.object({
  version: z.literal(1), taskId: z.string().uuid(), conversationId: z.string().uuid(),
  orgId: z.string().min(1), userId: z.string().min(1), employeeId: z.string(),
  title: z.string().max(80), createdAt: z.number(), turnId: z.string().uuid().optional(),
});
export type VoiceWorkBinding = z.infer<typeof VoiceWorkBindingSchema>;
export const VoiceWorkResultSchema = z.object({
  ok: z.boolean(), taskId: z.string().optional(), conversationId: z.string().optional(),
  title: z.string().optional(), status: z.string(), spokenSummary: z.string().max(240),
  artifactCount: z.number().optional(),
});
export type VoiceWorkResult = z.infer<typeof VoiceWorkResultSchema>;
export const VoiceWorkNoticeSchema = z.object({
  type: z.literal('completed'), taskId: z.string().uuid(), text: z.string().trim().min(1).max(50),
  /** Provider means the active realtime session owns playback; fallback uses one built-in sound. */
  delivery: z.enum(['provider', 'fallback']).optional(),
}).strict();
export type VoiceWorkNotice = z.infer<typeof VoiceWorkNoticeSchema>;
