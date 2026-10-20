import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_EMBEDDING_META, KnowledgeBaseRuntimeSchema } from '@openclawx/contracts';

test('embedding model metadata has stable product defaults', () => {
  assert.deepEqual(DEFAULT_EMBEDDING_META, {
    dimension: 1024,
    normalize: true,
    maxBatch: 32,
    maxInputChars: 8000,
  });
});

test('knowledge base accepts system embedding inheritance', () => {
  const parsed = KnowledgeBaseRuntimeSchema.parse({
    id: 'kb-system',
    name: 'System embedding',
    provider: 'lancedb',
    enabled: true,
    embeddingMode: 'system',
  });
  assert.equal(parsed.embeddingMode, 'system');
  assert.equal(parsed.embeddingModelConfigId, undefined);
});

test('knowledge base accepts a configured embedding model reference', () => {
  const parsed = KnowledgeBaseRuntimeSchema.parse({
    id: 'kb-model',
    name: 'Pinned embedding',
    provider: 'lancedb',
    enabled: true,
    embeddingMode: 'model',
    embeddingModelConfigId: 'embedding-qwen-v3',
  });
  assert.equal(parsed.embeddingMode, 'model');
  assert.equal(parsed.embeddingModelConfigId, 'embedding-qwen-v3');
});

test('legacy knowledge base remains valid without embedding selection fields', () => {
  const parsed = KnowledgeBaseRuntimeSchema.parse({
    id: 'kb-legacy',
    name: 'Legacy embedding',
    provider: 'lancedb',
    enabled: true,
    embeddingModel: 'text-embedding-v2',
    embeddingBaseUrl: 'https://example.test/v1',
  });
  assert.equal(parsed.embeddingMode, undefined);
  assert.equal(parsed.embeddingModel, 'text-embedding-v2');
  // Legacy records omit the field; runtime code treats anything except an
  // explicit false as enabled, avoiding a data migration.
  assert.equal(parsed.ontologyEnabled, undefined);
});

test('knowledge base can explicitly disable ontology-enhanced retrieval', () => {
  const parsed = KnowledgeBaseRuntimeSchema.parse({
    id: 'kb-vector-only',
    name: 'Vector only',
    provider: 'lancedb',
    enabled: true,
    ontologyEnabled: false,
  });
  assert.equal(parsed.ontologyEnabled, false);
});
