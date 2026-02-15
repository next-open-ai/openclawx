/**
 * Gateway 各通道入口的鉴权/安全钩子（占位模块）。
 * 连接之初可在此做 token 校验、限流等，当前暂不加逻辑，仅透传。
 */
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'http';

/** HTTP：/server-api 进入 Nest 前的鉴权钩子（占位，直接 next） */
export function authHookServerApi(req: Request, res: Response, next: NextFunction): void {
    next();
}

/** HTTP：/channel 进入通道模块前的鉴权钩子（占位，直接 next） */
export function authHookChannel(req: Request, res: Response, next: NextFunction): void {
    next();
}

/** HTTP：/sse 进入 SSE 前的鉴权钩子（占位，直接 next） */
export function authHookSse(req: Request, res: Response, next: NextFunction): void {
    next();
}

/**
 * WebSocket upgrade：/ws 或 /ws/voice 连接前的鉴权钩子（占位）。
 * 返回 true 表示放行，false 表示拒绝（调用方应关闭 socket）。
 */
export function authHookWs(
    _req: IncomingMessage,
    _path: string,
): boolean {
    return true;
}
