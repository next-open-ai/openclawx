import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { TagsService } from './tags.service.js';
import { randomUUID } from 'crypto';

export interface SavedItem {
    id: string;
    url: string;
    title: string | null;
    workspace: string;
    createdAt: number;
    tagIds: string[];
    tagNames?: string[];
}

interface SavedItemRow {
    id: string;
    url: string;
    title: string | null;
    workspace: string;
    created_at: number;
}

@Injectable()
export class SavedItemsService {
    constructor(
        private readonly db: DatabaseService,
        private readonly tagsService: TagsService,
    ) {}

    private async getTagIdsForItem(savedItemId: string): Promise<string[]> {
        const rows = this.db.all<{ tag_id: string }>(
            'SELECT tag_id FROM saved_item_tags WHERE saved_item_id = ?',
            [savedItemId],
        );
        return rows.map((r) => r.tag_id);
    }

    private async rowToSavedItem(row: SavedItemRow): Promise<SavedItem> {
        const tagIds = await this.getTagIdsForItem(row.id);
        const tagNames: string[] = [];
        for (const tagId of tagIds) {
            const tag = await this.tagsService.findById(tagId);
            if (tag) tagNames.push(tag.name);
        }
        return {
            id: row.id,
            url: row.url,
            title: row.title,
            workspace: row.workspace,
            createdAt: row.created_at,
            tagIds,
            tagNames,
        };
    }

    async create(dto: {
        url: string;
        title?: string;
        workspace?: string;
        tagNames?: string[];
        tagIds?: string[];
    }): Promise<SavedItem> {
        const url = (dto.url ?? '').trim();
        if (!url) throw new Error('url is required');
        const workspace = (dto.workspace ?? 'default').trim() || 'default';
        const title = dto.title?.trim() ?? null;
        const id = randomUUID();
        const createdAt = Date.now();
        this.db.run(
            'INSERT INTO saved_items (id, url, title, workspace, created_at) VALUES (?, ?, ?, ?, ?)',
            [id, url, title, workspace, createdAt],
        );
        let tagIds: string[] = [];
        if (dto.tagIds?.length) {
            tagIds = dto.tagIds;
        } else if (dto.tagNames?.length) {
            for (const name of dto.tagNames) {
                const tag = await this.tagsService.findByName(name.trim());
                if (tag) tagIds.push(tag.id);
            }
        }
        for (const tagId of tagIds) {
            this.db.run('INSERT INTO saved_item_tags (saved_item_id, tag_id) VALUES (?, ?)', [id, tagId]);
        }
        const row: SavedItemRow = { id, url, title, workspace, created_at: createdAt };
        return this.rowToSavedItem(row);
    }

    async findAll(options?: { tagId?: string; workspace?: string }): Promise<SavedItem[]> {
        let sql = 'SELECT id, url, title, workspace, created_at FROM saved_items WHERE 1=1';
        const params: unknown[] = [];
        if (options?.workspace) {
            sql += ' AND workspace = ?';
            params.push(options.workspace);
        }
        if (options?.tagId) {
            sql += ' AND id IN (SELECT saved_item_id FROM saved_item_tags WHERE tag_id = ?)';
            params.push(options.tagId);
        }
        sql += ' ORDER BY created_at DESC';
        const rows = this.db.all<SavedItemRow>(sql, params);
        const result: SavedItem[] = [];
        for (const row of rows) {
            result.push(await this.rowToSavedItem(row));
        }
        return result;
    }

    async findById(id: string): Promise<SavedItem | null> {
        const row = this.db.get<SavedItemRow>('SELECT id, url, title, workspace, created_at FROM saved_items WHERE id = ?', [id]);
        return row ? this.rowToSavedItem(row) : null;
    }

    async delete(id: string): Promise<void> {
        const item = await this.findById(id);
        if (!item) throw new NotFoundException('收藏不存在');
        this.db.run('DELETE FROM saved_item_tags WHERE saved_item_id = ?', [id]);
        this.db.run('DELETE FROM saved_items WHERE id = ?', [id]);
    }
}
