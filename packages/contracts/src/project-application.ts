import { z } from 'zod';

export const PublishProjectApplicationSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
export type PublishProjectApplication = z.infer<typeof PublishProjectApplicationSchema>;
export const ProjectApplicationSnapshotSchema = z.object({
  version: z.string().regex(/^[a-f0-9]{64}$/),
  entrypoint: z.enum(['index.html', 'output/index.html']),
  fileCount: z.number().int().min(1).max(500),
  bytes: z.number().int().min(1).max(32 * 1024 * 1024),
  publishedAt: z.number().int().nonnegative(),
  resources: z.array(z.string().min(1).max(2048)).max(500).optional(),
}).strict();
export type ProjectApplicationSnapshot = z.infer<typeof ProjectApplicationSnapshotSchema>;
export interface ProjectApplicationStatus {
  entrypoint: string | null;
  published: ProjectApplicationSnapshot | null;
}
export interface ProjectApplicationView {
  revision: string;
  entrypoint: string;
  fileCount: number;
  bytes: number;
  viewPath: string;
  expiresAt: number;
  resources: string[];
}
