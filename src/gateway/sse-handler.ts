/**
 * SSE 端点（占位）。
 * 后续：Agent 流式输出；当前返回 501 或简单说明。
 */
import type { Request, Response } from 'express';

export function handleSse(_req: Request, res: Response): void {
    res.status(501).setHeader('Content-Type', 'application/json').end(
        JSON.stringify({ ok: false, message: 'SSE endpoint not implemented yet' }),
    );
}
