import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export function isResourceInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Resolve existing ancestors without following a dangling symlink as a new file. */
async function canonicalResourcePath(candidate: string): Promise<string> {
  let existing = candidate;
  const missing: string[] = [];
  for (;;) {
    try {
      await lstat(existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
      continue;
    }
    // lstat succeeded: failure here includes dangling links and must fail closed.
    try { return path.join(await realpath(existing), ...missing); }
    catch { throw new Error('资源路径包含不可解析的符号链接，已拒绝访问。'); }
  }
}

export async function assertResourcePath(root: string, candidate: string): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  if (!isResourceInside(resolvedRoot, resolved)) throw new Error('路径超出当前授权工作区。请上传文件或使用已授权资源工具。');
  if (!isResourceInside(await canonicalResourcePath(resolvedRoot), await canonicalResourcePath(resolved))) {
    throw new Error('资源路径通过符号链接离开授权工作区，已拒绝访问。');
  }
  return resolved;
}

export class ResourceAccessPolicy {
  readonly root: string;
  private readonly readOnlyFiles: Set<string>;

  /** readOnlyFiles must come from a trusted host selection, never tool arguments. */
  constructor(root: string, readOnlyFiles: readonly string[] = []) {
    this.root = path.resolve(root);
    this.readOnlyFiles = new Set(readOnlyFiles.map((file) => path.resolve(file)));
  }

  async authorizeFile(candidate: string, access: 'read' | 'write'): Promise<string> {
    const resolved = path.resolve(this.root, candidate);
    if (access === 'read' && this.readOnlyFiles.has(resolved)) {
      // An exact grant is not a directory grant. Never infer parent/sibling access.
      if (!(await stat(resolved)).isFile()) throw new Error('外部输入授权必须指向具体文件，不能是目录。');
      return resolved;
    }
    const permitted = await assertResourcePath(this.root, resolved);
    if (access === 'read') await stat(permitted);
    return permitted;
  }

  /** Obvious shell exploration guard only; arbitrary scripts require an OS sandbox. */
  assertCommand(command: string): void {
    if (/\$\{?(HOME|OLDPWD)\}?|(^|[\s"'])~(?:\/|[\s"'])|\b(?:eval|source)\b|`|\$\(/.test(command)) {
      throw new Error('不允许通过用户目录变量或间接命令探查工作区外文件。');
    }
    for (const match of command.matchAll(/\bcd\s+(?:["']([^"']+)["']|([^\s;&|]+))/g)) {
      if (!isResourceInside(this.root, path.resolve(this.root, match[1] ?? match[2]))) throw new Error('不允许切换到授权工作区外目录。');
    }
    if (/(^|[\s"'=])\.\.(?:[\\/]|[\s"';|]|$)/.test(command)) throw new Error('不允许通过父目录路径探查工作区外文件。');
    for (const match of command.matchAll(/\/(?:Users|home|Volumes|tmp|private|etc|var|mnt|root)(?:\/[^\s"'`;|<>]*)?/g)) {
      if (!isResourceInside(this.root, path.resolve(match[0]))) throw new Error('不允许探查授权工作区外目录；输入文件请通过文件工具读取。');
    }
  }
}

export const RESOURCE_ACCESS_CONTRACT = [
  'Resource access policy: native filesystem tools operate in the authorized run/project workspace only.',
  'User-uploaded inputs are available through managed input paths or authorized attachment tools. An explicitly host-selected external file grants read access to that file only, never its parent directory or write access.',
  'Do not search home directories, unrelated projects, parent paths or other disks without explicit host authorization. A path mentioned in text is not an authorization.',
  'Access authorized Skill resources through load_skill/read_skill_file/run_skill_script and obey existing approvals. Access databases/APIs only through authorized connections, never by searching for credentials.',
  'Shell path checks are defense in depth, not an operating-system sandbox. Do not use scripts to bypass resource boundaries.',
].join('\n');
