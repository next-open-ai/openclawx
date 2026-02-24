import { Injectable } from '@nestjs/common';
import { readdir, stat, rm, mkdir, writeFile } from 'fs/promises';
import { join, resolve, relative } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { getOpenbotWorkspaceDir } from '../../core/agent/agent-dir.js';

/** 主智能体对应工作区名，禁止删除其目录 */
export const DEFAULT_WORKSPACE_NAME = 'default';

export interface WorkspaceItem {
    name: string;
    path: string; // relative path from workspace root
    isDirectory: boolean;
    size?: number;
    mtime?: number;
}

@Injectable()
export class WorkspaceService {
    private getWorkspaceRoot(name: string): string {
        return join(getOpenbotWorkspaceDir(), name);
    }

    /** List workspace names (directories under OPENBOT_WORKSPACE_DIR, default ~/.openbot/workspace) */
    async listWorkspaces(): Promise<string[]> {
        const base = getOpenbotWorkspaceDir();
        if (!existsSync(base)) {
            return [];
        }
        const entries = await readdir(base, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    }

    /** List files and folders under a path relative to workspace root. Empty path = root. */
    async listDocuments(workspaceName: string, relativePath: string = ''): Promise<WorkspaceItem[]> {
        const root = resolve(this.getWorkspaceRoot(workspaceName));
        if (!existsSync(root)) {
            return [];
        }
        const safePath = this.safeRelativePath(relativePath);
        const dir = resolve(root, safePath);
        const dirNormalized = resolve(dir);
        const rootNormalized = resolve(root);
        if (!dirNormalized.startsWith(rootNormalized) || !existsSync(dirNormalized)) {
            return [];
        }
        const entries = await readdir(dirNormalized, { withFileTypes: true });
        const items: WorkspaceItem[] = [];
        const hiddenDirNames = new Set(['skills', '.skills']);
        for (const e of entries) {
            if (e.isDirectory() && hiddenDirNames.has(e.name)) continue;
            const fullPath = join(dirNormalized, e.name);
            const rel = relative(rootNormalized, fullPath);
            let st: Awaited<ReturnType<typeof stat>>;
            try {
                st = await stat(fullPath);
            } catch (err: any) {
                if (err?.code === 'ENOENT') continue;
                throw err;
            }
            items.push({
                name: e.name,
                path: rel,
                isDirectory: st.isDirectory(),
                size: st.isFile() ? st.size : undefined,
                mtime: st.mtimeMs,
            });
        }
        return items.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
    }

    /**
     * Resolve a relative path and ensure it stays under workspace root.
     * Returns path suitable for join(workspaceRoot, result).
     */
    resolveFilePath(workspaceName: string, relativePath: string): { absolutePath: string; safe: boolean } {
        const root = resolve(this.getWorkspaceRoot(workspaceName));
        const safe = this.safeRelativePath(relativePath);
        const absolute = resolve(root, safe);
        const ok = resolve(absolute).startsWith(root) && existsSync(absolute);
        return { absolutePath: absolute, safe: ok };
    }

    /**
     * 删除整个工作区目录（磁盘）。禁止删除 default 工作区。
     * 仅当调用方确认需物理删除时使用（如删除智能体时用户勾选「同时删除工作区目录」）。
     */
    async deleteWorkspaceDirectory(workspaceName: string): Promise<void> {
        const name = (workspaceName || '').trim();
        if (name === '' || name === DEFAULT_WORKSPACE_NAME) {
            throw new Error('不能删除 default 工作区目录');
        }
        const root = resolve(this.getWorkspaceRoot(name));
        if (!existsSync(root)) return;
        await rm(root, { recursive: true });
    }

    /** Delete a file or directory (recursive) under workspace. Returns true if deleted. skills 与 .skills 目录禁止删除。 */
    async deletePath(workspaceName: string, relativePath: string): Promise<boolean> {
        const safe = this.safeRelativePath(relativePath);
        const topDir = safe.split('/')[0];
        if (topDir === 'skills' || topDir === '.skills') return false;
        const { absolutePath, safe: resolved } = this.resolveFilePath(workspaceName, relativePath);
        if (!resolved || !existsSync(absolutePath)) return false;
        await rm(absolutePath, { recursive: true });
        return true;
    }

    private safeRelativePath(relativePath: string): string {
        if (!relativePath || relativePath === '.') return '';
        const normalized = relativePath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '');
        const parts = normalized.split('/').filter((p) => p !== '..' && p !== '.');
        return parts.join('/');
    }

    /** Ensure workspace/.favorite directory exists. */
    async ensureFavoriteDir(workspaceName: string): Promise<string> {
        const root = resolve(this.getWorkspaceRoot(workspaceName));
        const favoriteDir = join(root, '.favorite');
        if (!existsSync(favoriteDir)) {
            await mkdir(favoriteDir, { recursive: true });
        }
        return favoriteDir;
    }

    /**
     * Write buffer to workspace/.favorite/{filename}. Returns relative path (e.g. .favorite/xxx).
     */
    async writeFileInFavorite(workspaceName: string, filename: string, buffer: Buffer): Promise<string> {
        const dir = await this.ensureFavoriteDir(workspaceName);
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'download';
        const absolutePath = join(dir, safeName);
        await writeFile(absolutePath, buffer);
        return `.favorite/${safeName}`;
    }

    /**
     * Write buffer to a user-chosen directory. targetDir must be absolute and under homedir or workspace root.
     * Returns the full path of the written file.
     */
    async writeFileToDir(targetDir: string, filename: string, buffer: Buffer): Promise<string> {
        const home = homedir();
        const workspaceRoot = getOpenbotWorkspaceDir();
        const normalized = resolve(targetDir);
        if (!normalized.startsWith(resolve(home)) && !normalized.startsWith(resolve(workspaceRoot))) {
            throw new Error('Target directory must be under user home or workspace root');
        }
        if (!existsSync(normalized)) {
            await mkdir(normalized, { recursive: true });
        }
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'download';
        const absolutePath = join(normalized, safeName);
        await writeFile(absolutePath, buffer);
        return absolutePath;
    }
}
