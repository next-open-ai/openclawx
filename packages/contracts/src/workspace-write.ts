import {z} from 'zod';

export const WorkspaceWriteStateSchema=z.object({
  writeId:z.string(),path:z.string(),mode:z.enum(['replace','append']),
  state:z.enum(['assembling','committing']),nextSeq:z.number().int().positive(),
  parts:z.number().int().nonnegative(),totalBytes:z.number().int().nonnegative(),
  totalParts:z.number().int().positive().optional(),maxAppendChars:z.number().int().positive(),
}).strict();
export type WorkspaceWriteState=z.infer<typeof WorkspaceWriteStateSchema>;
export const WorkspaceWriteErrorSchema=z.object({ok:z.literal(false),error:z.string(),code:z.string(),retryable:z.boolean(),state:WorkspaceWriteStateSchema.optional()}).strict();
export type WorkspaceWriteError=z.infer<typeof WorkspaceWriteErrorSchema>;
