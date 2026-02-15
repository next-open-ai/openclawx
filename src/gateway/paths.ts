/**
 * Gateway 路径常量：各模块使用独立 path 端点，便于路由与扩展。
 */
export const PATHS = {
    /** 业务 REST API（Nest） */
    SERVER_API: '/server-api',
    /** Agent 对话 WebSocket */
    WS: '/ws',
    /** 语音通道 WebSocket（扩展占位） */
    WS_VOICE: '/ws/voice',
    /** Agent 流式 SSE（占位） */
    SSE: '/sse',
    /** 通道模块（webhook / 回调） */
    CHANNEL: '/channel',
    /** 健康检查 */
    HEALTH: '/health',
    /** 定时任务执行（Nest 回调 Gateway） */
    RUN_SCHEDULED_TASK: '/run-scheduled-task',
} as const;

export type PathKey = keyof typeof PATHS;
