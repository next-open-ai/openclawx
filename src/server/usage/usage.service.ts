import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service.js';

export type TokenUsageSource = 'chat' | 'scheduled_task';

export interface RecordTokenUsageDto {
    sessionId: string;
    source: TokenUsageSource;
    taskId?: string;
    executionId?: string;
    promptTokens: number;
    completionTokens: number;
}

export interface TokenUsageTotal {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
}

@Injectable()
export class UsageService {
    constructor(private readonly db: DatabaseService) {}

    recordUsage(dto: RecordTokenUsageDto): void {
        const total = (dto.promptTokens || 0) + (dto.completionTokens || 0);
        if (total <= 0) return;
        this.db.run(
            `INSERT INTO token_usage (id, session_id, source, task_id, execution_id, prompt_tokens, completion_tokens, total_tokens, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                randomUUID(),
                dto.sessionId,
                dto.source,
                dto.taskId ?? null,
                dto.executionId ?? null,
                dto.promptTokens ?? 0,
                dto.completionTokens ?? 0,
                total,
                Date.now(),
            ],
        );
    }

    getTotal(): TokenUsageTotal {
        const row = this.db.get<{ total_prompt: number; total_completion: number; total_tokens: number }>(
            `SELECT
               COALESCE(SUM(prompt_tokens), 0) AS total_prompt,
               COALESCE(SUM(completion_tokens), 0) AS total_completion,
               COALESCE(SUM(total_tokens), 0) AS total_tokens
             FROM token_usage`,
        );
        if (!row) {
            return { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0 };
        }
        return {
            totalPromptTokens: row.total_prompt,
            totalCompletionTokens: row.total_completion,
            totalTokens: row.total_tokens,
        };
    }
}
