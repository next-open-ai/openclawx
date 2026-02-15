import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';

export interface UserItem {
    id: string;
    username: string;
    password: string;
}

interface UsersFile {
    users: UserItem[];
}

const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = '123456';

@Injectable()
export class UsersService {
    private usersPath: string;

    constructor() {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const configDir = join(homeDir, '.openbot', 'desktop');
        this.usersPath = join(configDir, 'users.json');
        if (!existsSync(configDir)) {
            mkdir(configDir, { recursive: true });
        }
    }

    private async load(): Promise<UserItem[]> {
        let users: UserItem[] = [];
        try {
            if (existsSync(this.usersPath)) {
                const content = await readFile(this.usersPath, 'utf-8');
                const data: UsersFile = JSON.parse(content);
                users = Array.isArray(data.users) ? data.users : [];
            }
        } catch (e) {
            console.error('Load users failed:', e);
        }
        if (users.length === 0) {
            const defaultAdmin: UserItem = {
                id: randomUUID(),
                username: DEFAULT_ADMIN_USERNAME,
                password: DEFAULT_ADMIN_PASSWORD,
            };
            users = [defaultAdmin];
            await this.save(users);
        }
        return users;
    }

    private async save(users: UserItem[]): Promise<void> {
        await writeFile(this.usersPath, JSON.stringify({ users }, null, 2));
    }

    async list(): Promise<{ id: string; username: string }[]> {
        const users = await this.load();
        return users.map((u) => ({ id: u.id, username: u.username }));
    }

    async create(username: string, password: string): Promise<{ id: string; username: string }> {
        const trimmed = (username ?? '').trim();
        const pass = (password ?? '').trim();
        if (!trimmed) throw new ConflictException('Username is required');
        const users = await this.load();
        const lower = trimmed.toLowerCase();
        if (users.some((u) => u.username.toLowerCase() === lower)) {
            throw new ConflictException('Username already exists');
        }
        const id = randomUUID();
        users.push({ id, username: trimmed, password: pass });
        await this.save(users);
        return { id, username: trimmed };
    }

    async update(id: string, updates: { username?: string; password?: string }): Promise<{ id: string; username: string }> {
        const users = await this.load();
        const idx = users.findIndex((u) => u.id === id);
        if (idx < 0) throw new NotFoundException('User not found');
        if (updates.username !== undefined) {
            const trimmed = updates.username.trim();
            if (!trimmed) throw new ConflictException('Username is required');
            const lower = trimmed.toLowerCase();
            if (users.some((u, i) => i !== idx && u.username.toLowerCase() === lower)) {
                throw new ConflictException('Username already exists');
            }
            users[idx].username = trimmed;
        }
        if (updates.password !== undefined) {
            users[idx].password = updates.password.trim();
        }
        await this.save(users);
        return { id: users[idx].id, username: users[idx].username };
    }

    async delete(id: string): Promise<void> {
        const users = await this.load();
        const filtered = users.filter((u) => u.id !== id);
        if (filtered.length === users.length) throw new NotFoundException('User not found');
        await this.save(filtered);
    }

    async validateCredentials(username: string, password: string): Promise<boolean> {
        const users = await this.load();
        if (users.length === 0) return false;
        const user = (username ?? '').trim().toLowerCase();
        const pass = (password ?? '').trim();
        const found = users.find((u) => u.username.toLowerCase() === user);
        return found ? found.password === pass : false;
    }

    /** 根据用户名查找用户（用于登录后返回当前用户信息） */
    async findByUsername(username: string): Promise<{ id: string; username: string } | null> {
        const users = await this.load();
        const lower = (username ?? '').trim().toLowerCase();
        const found = users.find((u) => u.username.toLowerCase() === lower);
        return found ? { id: found.id, username: found.username } : null;
    }

    async hasUsers(): Promise<boolean> {
        const users = await this.load();
        return users.length > 0;
    }

    /** 确保缺省 admin 用户存在，若不存在则创建并保存。返回该用户的 { id, username } */
    async ensureDefaultAdmin(): Promise<{ id: string; username: string }> {
        const users = await this.load();
        const existing = users.find((u) => u.username.toLowerCase() === DEFAULT_ADMIN_USERNAME.toLowerCase());
        if (existing) return { id: existing.id, username: existing.username };
        const defaultAdmin: UserItem = {
            id: randomUUID(),
            username: DEFAULT_ADMIN_USERNAME,
            password: DEFAULT_ADMIN_PASSWORD,
        };
        users.push(defaultAdmin);
        await this.save(users);
        return { id: defaultAdmin.id, username: defaultAdmin.username };
    }
}
