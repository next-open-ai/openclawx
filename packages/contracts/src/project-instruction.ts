import { z } from 'zod';

export const ProjectInstructionSchema = z.object({
  employeeId: z.string().trim().min(1).max(120),
  employeeLabel: z.string().trim().max(120).optional(),
  content: z.string().trim().min(1).max(32_000),
  requestId: z.string().uuid().optional(),
  fileIds: z.array(z.string().uuid()).max(10).default([]),
}).superRefine((value, ctx) => {
  if (value.fileIds.length && !value.requestId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '上传文档需要请求标识' });
  if (new Set(value.fileIds).size !== value.fileIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '文档不能重复' });
});
export type ProjectInstruction = z.infer<typeof ProjectInstructionSchema>;
