import {
    Controller,
    Get,
    Delete,
    Query,
    Res,
    HttpException,
    HttpStatus,
    NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import { WorkspaceService } from './workspace.service.js';
import { ConfigService } from '../config/config.service.js';

const PREVIEW_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf',
    'text/plain', 'text/html', 'text/markdown', 'application/json',
]);

function getMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const map: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
        webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
        txt: 'text/plain', html: 'text/html', htm: 'text/html', md: 'text/markdown',
        json: 'application/json',
    };
    return map[ext] || 'application/octet-stream';
}

@Controller('workspace')
export class WorkspaceController {
    constructor(
        private readonly workspaceService: WorkspaceService,
        private readonly configService: ConfigService,
    ) {}

    @Get()
    async listWorkspaces() {
        const list = await this.workspaceService.listWorkspaces();
        return { success: true, data: list };
    }

    @Get('current')
    async getCurrentWorkspace() {
        const config = await this.configService.getConfig();
        return { success: true, data: this.configService.getDefaultAgentId(config) };
    }

    @Get('documents')
    async listDocuments(
        @Query('workspace') workspace: string,
        @Query('path') path: string = '',
    ) {
        const name = workspace || this.configService.getDefaultAgentId(await this.configService.getConfig());
        const items = await this.workspaceService.listDocuments(name, path);
        return { success: true, data: items };
    }

    @Get('files/serve')
    async serveFile(
        @Query('workspace') workspace: string,
        @Query('path') path: string,
        @Query('download') download: string,
        @Res({ passthrough: false }) res: Response,
    ) {
        if (!path) {
            throw new HttpException('path is required', HttpStatus.BAD_REQUEST);
        }
        const name = workspace || this.configService.getDefaultAgentId(await this.configService.getConfig());
        const { absolutePath, safe } = this.workspaceService.resolveFilePath(name, path);
        if (!safe || !existsSync(absolutePath)) {
            throw new NotFoundException('File not found');
        }
        const fileStat = await stat(absolutePath);
        if (!fileStat.isFile()) {
            throw new HttpException('Not a file', HttpStatus.BAD_REQUEST);
        }
        const filename = path.split('/').pop() || path;
        const mime = getMimeType(filename);
        const isPreview = !download && PREVIEW_TYPES.has(mime);

        res.setHeader('Content-Type', mime);
        if (!isPreview) {
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        }
        const stream = createReadStream(absolutePath);
        stream.pipe(res);
    }

    @Delete('files')
    async deleteDocument(
        @Query('workspace') workspace: string,
        @Query('path') path: string,
    ) {
        if (!path) {
            throw new HttpException('path is required', HttpStatus.BAD_REQUEST);
        }
        const name = workspace || this.configService.getDefaultAgentId(await this.configService.getConfig());
        const deleted = await this.workspaceService.deletePath(name, path);
        if (!deleted) {
            throw new NotFoundException('File or folder not found');
        }
        return { success: true };
    }
}
