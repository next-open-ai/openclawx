/**
 * 默认的 provider 及模型目录，供配置时下拉备选。
 * 桌面 provider-support.json 若不存在则使用此默认并写入桌面目录。
 * 官方 provider 可预设 baseUrl，CLI login 时会写入 config；未知或自定义 OpenAI 接口可不设。
 */
/** 模型支持的能力类型，配置处（如 agent 配置、长记忆 embedding 选择）可按类型筛选可用模型 */
export type ModelSupportType = "llm" | "embedding" | "image" | "audio" | "video";

export interface ProviderSupportModel {
    id: string;
    name: string;
    /** 支持的类型，如 llm / embedding / image / audio / video；缺省视为 ["llm"] */
    types?: ModelSupportType[];
}

export interface ProviderSupportEntry {
    name: string;
    /** 官方 API 的 baseUrl，CLI login 时会写入 config；不设或空表示需用户在桌面填写（如自定义端点） */
    baseUrl?: string;
    models: ProviderSupportModel[];
}

export type ProviderSupport = Record<string, ProviderSupportEntry>;

export const DEFAULT_PROVIDER_SUPPORT: ProviderSupport = {
    deepseek: {
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        models: [
            { id: "deepseek-chat", name: "DeepSeek Chat", types: ["llm"] },
            { id: "deepseek-reasoner", name: "DeepSeek Reasoner", types: ["llm"] },
        ],
    },
    dashscope: {
        name: "DashScope (Alibaba)",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models: [
            { id: "qwen-max", name: "Qwen Max", types: ["llm"] },
            { id: "qwen-plus", name: "Qwen Plus", types: ["llm"] },
        ],
    },
    openai: {
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        models: [
            { id: "gpt-4o", name: "GPT-4o", types: ["llm"] },
            { id: "gpt-4o-mini", name: "GPT-4o Mini", types: ["llm"] },
            { id: "text-embedding-3-small", name: "Text Embedding 3 Small", types: ["embedding"] },
        ],
    },
    /** 自定义 Base URL，兼容所有 OpenAI 接口（本地/第三方兼容端点）；baseUrl 不预设，由用户在桌面填写 */
    "openai-custom": {
        name: "OpenAI (自定义)",
        models: [
            { id: "gpt-4o", name: "GPT-4o", types: ["llm"] },
            { id: "gpt-4o-mini", name: "GPT-4o Mini", types: ["llm"] },
            { id: "gpt-4-turbo", name: "GPT-4 Turbo", types: ["llm"] },
            { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo", types: ["llm"] },
            { id: "text-embedding-3-small", name: "Text Embedding 3 Small", types: ["embedding"] },
            { id: "text-embedding-ada-002", name: "Text Embedding Ada 002", types: ["embedding"] },
        ],
    },
    nvidia: {
        name: "NVIDIA",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        models: [
            { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5", types: ["llm"] },
            { id: "nvidia/nemotron-nano-12b-v2", name: "Nemotron Nano 12B v2", types: ["llm"] },
            { id: "nvidia/nemotron-nano-9b-v2", name: "Nemotron Nano 9B v2", types: ["llm"] },
        ],
    },
    kimi: {
        name: "Kimi (Moonshot)",
        baseUrl: "https://api.moonshot.cn/v1",
        models: [
            { id: "moonshot-v1-8k", name: "Moonshot 8K", types: ["llm"] },
            { id: "moonshot-v1-32k", name: "Moonshot 32K", types: ["llm"] },
            { id: "moonshot-v1-128k", name: "Moonshot 128K", types: ["llm"] },
        ],
    },
};
