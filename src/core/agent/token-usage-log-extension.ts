/**
 * 内置 extension：在 turn_start / turn_end 和 compaction 相关事件时打印 context 用量与 compaction 信息，
 * 便于分析 token 占用。仅打 log，不改变行为。
 * 若 agent-manager 在 session 创建后调用了 setTokenUsageInitialStats，则每轮会打印 systemPrompt/skills/tools/conversation 的估算占比。
 */
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

const LOG_PREFIX = "[token-usage]";

export interface TokenUsageInitialStats {
    systemPromptEstTokens: number;
    skillsBlockEstTokens: number;
    toolsDefsEstTokens: number;
}

const initialStatsByKey = new Map<string, TokenUsageInitialStats>();

/** 由 agent-manager 在 session 创建并算完 systemPrompt/skills/tools 后调用，供本 extension 在 turn 时打印占比 */
export function setTokenUsageInitialStats(compositeKey: string, stats: TokenUsageInitialStats): void {
    initialStatsByKey.set(compositeKey, stats);
}

function logContextBreakdown(phase: string, totalTokens: number, compositeKey: string): void {
    const stats = initialStatsByKey.get(compositeKey);
    if (!stats || totalTokens <= 0) return;
    const { systemPromptEstTokens, skillsBlockEstTokens, toolsDefsEstTokens } = stats;
    const conversationEst = Math.max(0, totalTokens - systemPromptEstTokens - toolsDefsEstTokens);
    console.log(
        `${LOG_PREFIX} ${phase} breakdown | total=${totalTokens} systemPrompt≈${systemPromptEstTokens} (含skills≈${skillsBlockEstTokens}) tools≈${toolsDefsEstTokens} conversation≈${conversationEst}`
    );
}

type PiOn = (event: string, handler: (...args: unknown[]) => void) => void;

export function createTokenUsageLogExtensionFactory(compositeKey: string): ExtensionFactory {
    return (pi) => {
        const on = pi.on.bind(pi) as PiOn;
        on("turn_start", (_event: unknown, ctx: unknown) => {
            const c = ctx as { getContextUsage?: () => { tokens?: number } };
            try {
                const usage = c?.getContextUsage?.();
                if (usage && typeof usage.tokens === "number") {
                    console.log(
                        `${LOG_PREFIX} turn_start contextUsage.tokens=${usage.tokens} (估算，用于判断是否触发 compaction)`
                    );
                    logContextBreakdown("turn_start", usage.tokens, compositeKey);
                }
            } catch {
                // ignore
            }
        });

        on("turn_end", (_event: unknown, ctx: unknown) => {
            const c = ctx as { getContextUsage?: () => { tokens?: number } };
            try {
                const usage = c?.getContextUsage?.();
                if (usage && typeof usage.tokens === "number") {
                    console.log(
                        `${LOG_PREFIX} turn_end contextUsage.tokens=${usage.tokens} (本轮结束后)`
                    );
                    logContextBreakdown("turn_end", usage.tokens, compositeKey);
                }
            } catch {
                // ignore
            }
        });

        on("session_compact", (event: unknown) => {
            const e = event as { compactionEntry?: { summary?: string; tokensBefore?: number } };
            const entry = e?.compactionEntry;
            const tokensBefore = entry?.tokensBefore;
            const summaryLen = typeof entry?.summary === "string" ? entry.summary.length : 0;
            console.log(
                `${LOG_PREFIX} session_compact 已触发 tokensBefore=${tokensBefore ?? "?"} summaryChars=${summaryLen}`
            );
        });

        on("auto_compaction_start", (event: unknown) => {
            const e = event as { reason?: string };
            console.log(
                `${LOG_PREFIX} auto_compaction_start 已触发 reason=${String(e?.reason ?? "?")}`
            );
        });

        on("auto_compaction_end", (event: unknown) => {
            const e = event as {
                result?: unknown;
                aborted?: boolean;
                willRetry?: boolean;
                errorMessage?: string;
            };
            const { result, aborted, willRetry, errorMessage } = e ?? {};
            console.log(
                `${LOG_PREFIX} auto_compaction_end 已结束 aborted=${aborted} willRetry=${willRetry} result=${result != null ? "ok" : "null"}${errorMessage ? ` error=${errorMessage}` : ""}`
            );
        });
    };
}
