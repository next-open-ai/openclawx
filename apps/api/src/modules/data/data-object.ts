import { dataObjectAnnotationsSchema, dataObjectModelSchema, type DataObjectAnnotations, type DataResource } from '@workmate/contracts';

export function readAnnotations(raw?: unknown): DataObjectAnnotations {
  // Missing metadata on older objects is valid; malformed stored metadata is not.
  return dataObjectAnnotationsSchema.parse(raw ? JSON.parse(String(raw)) : {});
}

export function modelReadableSchema(source: {
  id: string; name: string; fileType: string; annotations: DataObjectAnnotations;
  tables?: DataResource[];
  accessMode?: 'live' | 'snapshot' | 'local';
  api?: { method: string; baseUrl: string; path: string; itemsPath: string; description: string } | null;
}) {
  return dataObjectModelSchema.parse({
    id: source.id, name: source.name, kind: source.fileType, annotations: source.annotations,
    storageMode: source.accessMode,
    resources: (source.tables || []).map(table => ({
      id: table.id, name: table.name, sheetName: table.sheetName, description: table.description || '',
      columns: table.columns.map(({ sample: _sample, ...column }) => column),
    })),
    ...(source.api ? { api: {
      method: source.api.method, url: safeDocumentUrl(source.api.baseUrl, source.api.path),
      itemsPath: source.api.itemsPath, description: source.api.description,
    } } : {}),
    operations: ['query', 'options'],
  });
}

function safeDocumentUrl(baseUrl: string, requestPath: string) {
  const url = new URL(requestPath.startsWith('http') ? requestPath : `${baseUrl.replace(/\/$/, '')}/${requestPath.replace(/^\//, '')}`);
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return url.toString();
}

export function jsonDataRows(value: unknown): Array<Record<string, unknown>> {
  const items = Array.isArray(value) ? value : value !== null && typeof value === 'object' ? [value] : [];
  if (!items.length || !items.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) {
    throw new Error('JSON 需为一个对象或非空对象数组。');
  }
  if (items.length > 20_000) throw new Error('每次导入最多 20,000 行数据。');
  return items as Array<Record<string, unknown>>;
}
