/**
 * Embedding 抽象：便于后续切换不同实现（在线 OpenAPI、node-llama-cpp GGUF 等）。
 * 调用方仅依赖 embed(text) => Promise<number[] | null>。
 */

export interface IEmbeddingProvider {
    /** 单条文本向量化，不可用时返回 null */
    embed(text: string): Promise<number[] | null>;
    /** 提供方名称，用于日志 */
    readonly name: string;
}
