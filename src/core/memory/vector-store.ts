import { join } from "node:path";
import { LocalIndex } from "vectra";
import { getOpenbotAgentDir } from "../agent/agent-dir.js";
import type { InfoType, MemoryMetadata } from "./types.js";

const INDEX_DIR_NAME = "memory";

let indexDir: string | null = null;
let index: LocalIndex | null = null;

function getIndexDir(): string {
    if (!indexDir) {
        indexDir = join(getOpenbotAgentDir(), INDEX_DIR_NAME);
    }
    return indexDir;
}

async function getIndex(): Promise<LocalIndex> {
    if (index) return index;
    const path = getIndexDir();
    index = new LocalIndex(path);
    if (!(await index.isIndexCreated())) {
        await index.createIndex();
    }
    return index;
}

/** Vectra 返回 score（相似度 0~1，越大越相似）；转为 distance = 1 - score，与现有 API 一致 */
function scoreToDistance(score: number): number {
    return 1 - score;
}

export async function getChroma(): Promise<{ client: null; collection: null }> {
    await getIndex();
    return { client: null, collection: null };
}

export async function addToStore(
    id: string,
    embedding: number[],
    document: string,
    metadata: MemoryMetadata,
): Promise<void> {
    const idx = await getIndex();
    await idx.upsertItem({
        id,
        vector: embedding,
        metadata: {
            document,
            infotype: metadata.infotype,
            sessionId: metadata.sessionId,
            createdAt: metadata.createdAt,
        },
    });
}

export type MemoryFilter = { infotype?: InfoType; sessionId?: string };

export async function queryStore(
    queryEmbedding: number[],
    topK: number = 10,
    filter?: MemoryFilter,
): Promise<{ document: string; metadata: MemoryMetadata; distance?: number }[]> {
    const idx = await getIndex();
    const vectraFilter =
        filter && (filter.infotype != null || filter.sessionId != null)
            ? {
                  ...(filter.infotype != null && { infotype: { $eq: filter.infotype } }),
                  ...(filter.sessionId != null && { sessionId: { $eq: filter.sessionId } }),
              }
            : undefined;
    const results = await idx.queryItems(queryEmbedding, "", topK, vectraFilter as any);
    return results.map((r) => {
        const meta = (r.item.metadata ?? {}) as Record<string, unknown>;
        return {
            document: String(meta.document ?? ""),
            metadata: {
                infotype: meta.infotype as MemoryMetadata["infotype"],
                sessionId: String(meta.sessionId ?? ""),
                createdAt: String(meta.createdAt ?? ""),
            },
            distance: scoreToDistance(r.score),
        };
    });
}
