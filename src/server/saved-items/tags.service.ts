import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { randomUUID } from 'crypto';

export interface Tag {
    id: string;
    name: string;
    sortOrder: number;
    createdAt: number;
}

interface TagRow {
    id: string;
    name: string;
    sort_order: number;
    created_at: number;
}

@Injectable()
export class TagsService {
    constructor(private readonly db: DatabaseService) {}

    private rowToTag(row: TagRow): Tag {
        return {
            id: row.id,
            name: row.name,
            sortOrder: row.sort_order,
            createdAt: row.created_at,
        };
    }

    async findAll(): Promise<Tag[]> {
        const rows = this.db.all<TagRow>(
            'SELECT id, name, sort_order, created_at FROM tags ORDER BY sort_order ASC, name ASC',
            [],
        );
        return rows.map((r) => this.rowToTag(r));
    }

    async findById(id: string): Promise<Tag | null> {
        const row = this.db.get<TagRow>('SELECT id, name, sort_order, created_at FROM tags WHERE id = ?', [id]);
        return row ? this.rowToTag(row) : null;
    }

    async findByName(name: string): Promise<Tag | null> {
        const row = this.db.get<TagRow>('SELECT id, name, sort_order, created_at FROM tags WHERE name = ?', [
            name.trim(),
        ]);
        return row ? this.rowToTag(row) : null;
    }

    async create(dto: { name: string; sortOrder?: number }): Promise<Tag> {
        const name = (dto.name ?? '').trim();
        if (!name) throw new ConflictException('标签名不能为空');
        const existing = await this.findByName(name);
        if (existing) throw new ConflictException('该标签名已存在');
        const id = randomUUID();
        const sortOrder = dto.sortOrder ?? 0;
        const createdAt = Date.now();
        this.db.run(
            'INSERT INTO tags (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)',
            [id, name, sortOrder, createdAt],
        );
        return { id, name, sortOrder, createdAt };
    }

    async update(id: string, dto: { name?: string; sortOrder?: number }): Promise<Tag> {
        const tag = await this.findById(id);
        if (!tag) throw new NotFoundException('标签不存在');
        if (dto.name !== undefined) {
            const name = dto.name.trim();
            if (!name) throw new ConflictException('标签名不能为空');
            const existing = await this.findByName(name);
            if (existing && existing.id !== id) throw new ConflictException('该标签名已存在');
            this.db.run('UPDATE tags SET name = ? WHERE id = ?', [name, id]);
            tag.name = name;
        }
        if (dto.sortOrder !== undefined) {
            this.db.run('UPDATE tags SET sort_order = ? WHERE id = ?', [dto.sortOrder, id]);
            tag.sortOrder = dto.sortOrder;
        }
        return tag;
    }

    async delete(id: string): Promise<void> {
        const tag = await this.findById(id);
        if (!tag) throw new NotFoundException('标签不存在');
        this.db.run('DELETE FROM tags WHERE id = ?', [id]);
    }
}
