import type { AgentTool } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  createCodingTools,
  createReadOnlyTools,
} from '@mariozechner/pi-coding-agent';
import { Type, defineAgentTool } from './pi-tools.js';
import { WorkspaceCapabilityKernel, type CapabilityContext } from './capability-kernel.js';
import {
  ARTIFACT_SOURCE_MAX_CHUNK_CHARS,
  appendArtifactSourceWrite,
  finishArtifactSourceWrite,
  startArtifactSourceWrite,
} from './artifact-source-writer.js';

/**
 * Pi adapter. Pi performs ordinary filesystem operations with its unmodified
 * native coding tools; Workmate only selects tools by permission, hooks bash
 * at Pi's documented spawn boundary, and owns the artifact commit boundary.
 */
export function createPiCapabilityTools(context: CapabilityContext): AgentTool<any>[] {
  const kernel = new WorkspaceCapabilityKernel(context);
  const cwd = kernel.root;
  const rawNativeTools = context.workspaceAccess === 'read'
    ? createReadOnlyTools(cwd)
    : createCodingTools(cwd, {
      bash: { spawnHook: (spawn) => ({ ...spawn, cwd, command: kernel.assertCommand(spawn.command) }) },
    });
  const nativeTools = rawNativeTools.map((tool) => ({
    ...tool,
    execute: async (id: string, args: any, signal?: AbortSignal, update?: any) => {
      signal?.throwIfAborted();
      if (tool.name === 'bash') {
        kernel.assertCommand(String(args.command ?? ''));
        return tool.execute(id, args, signal, update);
      }
      // Match Pi path expansion before checking; pass the authorized absolute
      // path onward so @/~ and Unicode-space handling cannot bypass the gate.
      let requested = String(args.path ?? '.').replace(/^@/, '').replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
      if (requested === '~' || requested.startsWith('~/')) requested = homedir() + requested.slice(1);
      const authorized = await kernel.authorizeFile(requested, tool.name === 'write' || tool.name === 'edit' ? 'write' : 'read');
      signal?.throwIfAborted();
      return tool.execute(id, { ...args, path: authorized }, signal, update);
    },
  }));
  const commitArtifact = defineAgentTool({
    name: 'commit_artifact',
    label: 'commit_artifact',
    description: 'Verify and atomically publish one finished user-facing file. Call this only after write/edit succeeds. Only a committed artifact is shown in the asset library.',
    parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 240 }) }),
    execute: ({ path }) => kernel.commitArtifact(path),
  });

  const largeArtifactTools = context.workspaceAccess === 'read' ? [] : [
    defineAgentTool({
      name: 'start_artifact_source_write',
      description: context.workspaceMode === 'project'
        ? 'Start a host-managed large single-file write in the project root. Use only when complete source is too large for native write. Use index.html or another real project path; never prefix it with output/. Append ordered fragments, then finish for one atomic replacement.'
        : 'Start a host-managed large single-file artifact write. Use only when complete source is too large for native write. The destination must be under output/. Append ordered fragments, then finish for one atomic replacement.',
      parameters: Type.Object({
        path: Type.String({ minLength: 8, maxLength: 240 }),
        totalParts: Type.Integer({ minimum: 1, maximum: 512 }),
      }),
      execute: async ({ path: relative, totalParts }) => {
        await kernel.authorizeFile(relative, 'write');
        const safePath = kernel.assertWritePath(path.resolve(kernel.root, relative));
        const session = startArtifactSourceWrite({
          workspaceRoot: kernel.root,
          path: safePath,
          totalParts,
          requireOutput: context.workspaceMode !== 'project',
        });
        return { ok: true, writeId: session.id, path: session.relativePath, totalParts: session.totalParts, maxChunkChars: ARTIFACT_SOURCE_MAX_CHUNK_CHARS };
      },
    }),
    defineAgentTool({
      name: 'append_artifact_source_write',
      description: `Append the next ordered fragment to a host-managed large artifact write. Each fragment must be at most ${ARTIFACT_SOURCE_MAX_CHUNK_CHARS} characters.`,
      parameters: Type.Object({
        writeId: Type.String({ minLength: 8, maxLength: 80 }),
        seq: Type.Integer({ minimum: 1, maximum: 512 }),
        content: Type.String({ minLength: 1, maxLength: ARTIFACT_SOURCE_MAX_CHUNK_CHARS }),
      }),
      execute: ({ writeId, seq, content }) => {
        const session = appendArtifactSourceWrite({ writeId, seq, content });
        return { ok: true, writeId, path: session.relativePath, receivedParts: session.parts.length, nextSeq: session.nextSeq, bytes: session.bytes };
      },
    }),
    defineAgentTool({
      name: 'finish_artifact_source_write',
      description: 'Validate all large-artifact fragments and atomically replace the destination file. Call commit_artifact afterwards to archive the deliverable.',
      parameters: Type.Object({ writeId: Type.String({ minLength: 8, maxLength: 80 }) }),
      execute: async ({ writeId }) => ({ ok: true, ...(await finishArtifactSourceWrite(writeId)), readyForCommit: true }),
    }),
  ];

  return [...nativeTools, ...largeArtifactTools, ...(context.workspaceAccess === 'read' ? [] : [commitArtifact])];
}
