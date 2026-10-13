import { z } from 'zod';

export const CreateConversationProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  goal: z.string().trim().max(8_000).default(''),
  employeeId: z.string().trim().min(1).max(120).default('general'),
  workspace: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('system') }).strict(),
    z.object({ mode: z.literal('custom'), parentPath: z.string().trim().min(1).max(4096) }).strict(),
  ]).optional(),
}).strict();
export type CreateConversationProject = z.infer<typeof CreateConversationProjectSchema>;

export const ProjectDraftFileQuerySchema = z.object({
  relative: z.string().min(1).max(2048).refine(value => !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.startsWith('.')), '草稿路径不合法'),
}).strict();
export type ProjectDraftFiles = { files: Array<{ relative: string; type: 'file' }>; truncated: boolean };
