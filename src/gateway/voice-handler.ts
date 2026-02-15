/**
 * 语音通道 WebSocket（占位）。
 * 后续：/ws/voice 建连、二进制/信令、与语音服务对接；当前仅关闭连接并返回 400 或不做 upgrade。
 */
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { PATHS } from './paths.js';

/**
 * 处理 /ws/voice 的 upgrade 请求（占位）。
 * 返回 true 表示已处理（例如拒绝并关闭），调用方不必再交给 agent /ws；
 * 返回 false 表示未处理。
 */
export function handleVoiceUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    _head: Buffer,
): boolean {
    const path = req.url?.split('?')[0] || '';
    if (path !== PATHS.WS_VOICE) {
        return false;
    }
    socket.write(
        'HTTP/1.1 501 Not Implemented\r\n' +
        'Content-Type: application/json\r\n' +
        'Connection: close\r\n\r\n' +
        JSON.stringify({ ok: false, message: 'Voice WebSocket not implemented yet' }),
    );
    socket.destroy();
    return true;
}
