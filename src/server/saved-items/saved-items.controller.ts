import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Param,
    Query,
    Res,
    HttpException,
    HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { SavedItemsService } from './saved-items.service.js';
import { WorkspaceService } from '../workspace/workspace.service.js';
import { ConfigService } from '../config/config.service.js';
import { getOpenbotWorkspaceDir } from '../../core/agent/agent-dir.js';

const IMAGE_EXT_MIME: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
};

function mimeFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    return IMAGE_EXT_MIME[ext] || 'application/octet-stream';
}

function safeFilenameFromUrl(url: string, contentType?: string): string {
    try {
        const u = new URL(url);
        const pathname = u.pathname || '';
        const segment = pathname.split('/').filter(Boolean).pop() || '';
        const decoded = decodeURIComponent(segment);
        const base = decoded.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
        if (base) return base;
    } catch (_) {}
    const ct = (contentType || '').split(';')[0].trim().toLowerCase();
    let ext = 'bin';
    if (ct.includes('image/')) ext = ct.replace('image/', '').trim() || 'png';
    else if (ct.includes('text/html')) ext = 'html';
    else if (ct.includes('text/plain')) ext = 'txt';
    return `download_${Date.now()}.${ext}`;
}

@Controller('saved-items')
export class SavedItemsController {
    constructor(
        private readonly savedItemsService: SavedItemsService,
        private readonly workspaceService: WorkspaceService,
        private readonly configService: ConfigService,
    ) {}

    @Get()
    async list(
        @Query('tagId') tagId?: string,
        @Query('workspace') workspace?: string,
    ) {
        const data = await this.savedItemsService.findAll({ tagId, workspace });
        return { success: true, data };
    }

    @Get('image-proxy')
    async imageProxy(@Query('url') url: string, @Res({ passthrough: false }) res: Response) {
        if (!url?.trim()) throw new HttpException('url is required', HttpStatus.BAD_REQUEST);
        const decoded = decodeURIComponent(url.trim());

        if (decoded.startsWith('file://') || decoded.startsWith('file:/')) {
            try {
                let pathPart: string;
                try {
                    const u = new URL(decoded);
                    pathPart = (u.pathname || decoded).replace(/^\/([a-z]:)/i, '$1');
                } catch {
                    pathPart = decoded.replace(/^file:\/+/, '').replace(/^\/([a-z]:)/i, '$1');
                }
                const absolutePath = resolve(pathPart);
                const home = homedir();
                const workspaceRoot = getOpenbotWorkspaceDir();
                if (
                    !absolutePath.startsWith(resolve(home)) &&
                    !absolutePath.startsWith(resolve(workspaceRoot))
                ) {
                    throw new HttpException('Local file path not allowed', HttpStatus.FORBIDDEN);
                }
                if (!existsSync(absolutePath)) {
                    throw new HttpException('File not found', HttpStatus.NOT_FOUND);
                }
                const buffer = await readFile(absolutePath);
                const contentType = mimeFromPath(absolutePath);
                res.setHeader('Content-Type', contentType);
                res.send(buffer);
            } catch (e: unknown) {
                if (e instanceof HttpException) throw e;
                throw new HttpException('Local file read failed', HttpStatus.BAD_GATEWAY);
            }
            return;
        }

        try {
            const resFetch = await fetch(decoded, { redirect: 'follow' });
            if (!resFetch.ok) throw new HttpException('Upstream failed', HttpStatus.BAD_GATEWAY);
            const contentType = resFetch.headers.get('content-type') || 'application/octet-stream';
            res.setHeader('Content-Type', contentType);
            const arr = new Uint8Array(await resFetch.arrayBuffer());
            res.send(Buffer.from(arr));
        } catch (e: unknown) {
            if (e instanceof HttpException) throw e;
            throw new HttpException('Proxy failed', HttpStatus.BAD_GATEWAY);
        }
    }

    @Get(':id')
    async get(@Param('id') id: string) {
        const data = await this.savedItemsService.findById(id);
        if (!data) throw new HttpException('Saved item not found', HttpStatus.NOT_FOUND);
        return { success: true, data };
    }

    @Post()
    async create(
        @Body()
        body: {
            url: string;
            title?: string;
            workspace?: string;
            tagNames?: string[];
            tagIds?: string[];
        },
    ) {
        const data = await this.savedItemsService.create({
            url: body.url,
            title: body.title,
            workspace: body.workspace,
            tagNames: body.tagNames,
            tagIds: body.tagIds,
        });
        return { success: true, data };
    }

    @Delete(':id')
    async delete(@Param('id') id: string) {
        await this.savedItemsService.delete(id);
        return { success: true };
    }

    /**
     * Download the saved item URL to workspace .favorite or to a user-chosen directory.
     * Body: { workspace?: string, targetDir?: string }.
     * If targetDir (absolute path) is provided, file is written there; otherwise to workspace/.favorite.
     */
    @Post(':id/download-to-workspace')
    async downloadToWorkspace(
        @Param('id') id: string,
        @Body() body: { workspace?: string; targetDir?: string },
    ) {
        const item = await this.savedItemsService.findById(id);
        if (!item) throw new HttpException('Saved item not found', HttpStatus.NOT_FOUND);
        const workspace =
            (body?.workspace ?? '').trim() ||
            this.configService.getDefaultAgentId(await this.configService.getConfig());
        let buffer: Buffer;
        let contentType: string | undefined;
        try {
            const res = await fetch(item.url, { redirect: 'follow' });
            if (!res.ok) {
                throw new HttpException(
                    `Failed to fetch URL: ${res.status} ${res.statusText}`,
                    HttpStatus.BAD_GATEWAY,
                );
            }
            contentType = res.headers.get('content-type') || undefined;
            const arr = new Uint8Array(await res.arrayBuffer());
            buffer = Buffer.from(arr);
        } catch (err: unknown) {
            if (err instanceof HttpException) throw err;
            const msg = err instanceof Error ? err.message : String(err);
            throw new HttpException(`Download failed: ${msg}`, HttpStatus.BAD_GATEWAY);
        }
        const filename = safeFilenameFromUrl(item.url, contentType);
        if ((body?.targetDir ?? '').trim()) {
            const absolutePath = await this.workspaceService.writeFileToDir(
                body.targetDir!.trim(),
                filename,
                buffer,
            );
            return { success: true, data: { absolutePath, targetDir: body.targetDir!.trim() } };
        }
        const relativePath = await this.workspaceService.writeFileInFavorite(workspace, filename, buffer);
        return { success: true, data: { relativePath, workspace } };
    }
}
