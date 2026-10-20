import path from 'node:path';
import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import type { CreateConversationProject } from '@openclawx/contracts';

export class ProjectDirectoryError extends Error {}

/** Always own a fresh child: delivery promotion must never rename the user's parent. */
export async function createConversationDirectory(dataRoot: string, id: string, workspace: CreateConversationProject['workspace']): Promise<string> {
  let parent: string;
  if (workspace?.mode === 'custom') {
    const selected = workspace.parentPath;
    if (!path.isAbsolute(selected) || selected.includes('\0')) throw new ProjectDirectoryError('请选择有效的绝对目录路径。');
    try {
      const stat = await lstat(selected);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a directory');
      parent = await realpath(selected);
      if (parent === path.parse(parent).root) throw new Error('filesystem root');
      await access(parent, constants.W_OK | constants.X_OK);
    } catch {
      throw new ProjectDirectoryError('所选位置必须是已存在、可写的普通目录，不能是根目录或目录快捷链接。请重新选择。');
    }
  } else {
    parent = path.join(dataRoot, 'projects');
    await mkdir(parent, { recursive: true, mode: 0o700 });
  }
  const directory = path.join(parent, `conversation-${id}`);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch {
    throw new ProjectDirectoryError('无法创建项目目录，请检查保存位置的权限或可用空间后重试。');
  }
  return directory;
}
