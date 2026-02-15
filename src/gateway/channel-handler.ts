/**
 * 通道模块 HTTP 处理（占位）。
 * 后续：接收外部 webhook、回调，校验后转内部事件；当前返回 501。
 */
import type { Request, Response } from 'express';

export function handleChannel(_req: Request, res: Response): void {
    res.status(501).setHeader('Content-Type', 'application/json').end(
        JSON.stringify({ ok: false, message: 'Channel module not implemented yet' }),
    );
}
