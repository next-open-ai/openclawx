/**
 * 工具返回结果按 token 估算截断：超过 maxTokens 时从尾部裁剪并打日志。
 * 用于 MCP、web_search 等单次返回可能过大的场景。
 */

const LOG_PREFIX = "[tool-result]";

/** 粗略按字符估算 token（中英混合约 1/3） */
export function estTokensFromChars(chars: number): number {
    return Math.ceil(chars / 3);
}

/**
 * 若 text 估算 token 超过 maxTokens，则保留前 maxTokens 对应字符并打日志，否则返回原 text。
 * @param text 原始文本
 * @param maxTokens 最大保留 token 数（仅当 > 0 时生效）
 * @param toolLabel 工具标识，用于日志
 * @returns 截断后的文本（可能为原 text）
 */
export function truncateTextToMaxTokens(
    text: string,
    maxTokens: number,
    toolLabel: string,
): string {
    if (!text || maxTokens <= 0) return text;
    const est = estTokensFromChars(text.length);
    if (est <= maxTokens) return text;
    const keepChars = Math.max(1, maxTokens * 3);
    const truncated = text.slice(0, keepChars);
    console.log(
        `${LOG_PREFIX} ${toolLabel} 返回超限 estTokens=${est} maxTokens=${maxTokens} 已从尾部裁剪，保留约 ${maxTokens} token`,
    );
    return truncated;
}
