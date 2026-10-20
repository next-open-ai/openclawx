import { createHash, createHmac, randomUUID } from 'node:crypto';

/** Minimal ACS3-HMAC-SHA256 client for Bailian OpenAPI. */

export type BailianAuth = {
  accessKeyId: string;
  accessKeySecret: string;
  workspaceId: string;
  endpoint?: string;
};

function sha256Hex(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalQuery(params: Record<string, string | number | boolean | undefined>) {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
    .join('&');
}

function normalizeEndpoint(endpoint?: string) {
  return (endpoint || 'bailian.cn-beijing.aliyuncs.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function requireAuth(auth: BailianAuth) {
  const accessKeyId = auth.accessKeyId.trim();
  const accessKeySecret = auth.accessKeySecret.trim();
  const workspaceId = auth.workspaceId.trim();
  if (!accessKeyId || !accessKeySecret) throw new Error('Aliyun AccessKey Id/Secret are required for Bailian OpenAPI.');
  if (!workspaceId) throw new Error('Bailian workspaceId is required.');
  return { accessKeyId, accessKeySecret, workspaceId, endpoint: auth.endpoint };
}

async function bailianOpenApiCall(input: {
  accessKeyId: string;
  accessKeySecret: string;
  action: string;
  method?: 'GET' | 'POST' | 'PUT';
  pathname: string;
  query?: Record<string, string | number | boolean | undefined>;
  formBody?: Record<string, string>;
  jsonBody?: Record<string, unknown>;
  endpoint?: string;
}): Promise<any> {
  const method = input.method || 'POST';
  const host = normalizeEndpoint(input.endpoint);
  const pathname = input.pathname.startsWith('/') ? input.pathname : `/${input.pathname}`;
  const queryString = canonicalQuery(input.query || {});

  let bodyBuffer = Buffer.alloc(0);
  let contentType = '';
  if (input.jsonBody) {
    const raw = JSON.stringify(input.jsonBody);
    bodyBuffer = Buffer.from(raw, 'utf8');
    contentType = 'application/json; charset=utf-8';
  } else if (input.formBody) {
    const form = Object.keys(input.formBody)
      .filter((key) => input.formBody![key] !== undefined && input.formBody![key] !== '')
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(input.formBody![key])}`)
      .join('&');
    bodyBuffer = Buffer.from(form, 'utf8');
    contentType = 'application/x-www-form-urlencoded';
  }

  const hashedPayload = sha256Hex(bodyBuffer);
  // Aliyun ACS3 requires ISO8601 UTC: yyyy-MM-ddTHH:mm:ssZ (not AWS compact YYYYMMDDThhmmssZ).
  const amzDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = randomUUID();
  const headersMap: Record<string, string> = {
    host,
    'x-acs-action': input.action,
    'x-acs-content-sha256': hashedPayload,
    'x-acs-date': amzDate,
    'x-acs-signature-nonce': nonce,
    'x-acs-version': '2023-12-29',
  };
  if (contentType) headersMap['content-type'] = contentType;

  const signedHeadersList = Object.keys(headersMap).sort();
  const canonicalHeaders = `${signedHeadersList.map((name) => `${name}:${headersMap[name]}`).join('\n')}\n`;
  const signedHeaders = signedHeadersList.join(';');
  const canonicalRequest = [method, pathname, queryString, canonicalHeaders, signedHeaders, hashedPayload].join('\n');
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`;
  const signature = createHmac('sha256', input.accessKeySecret).update(stringToSign, 'utf8').digest('hex');
  const authorization = `ACS3-HMAC-SHA256 Credential=${input.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;

  const url = `https://${host}${pathname}${queryString ? `?${queryString}` : ''}`;
  const response = await fetch(url, {
    method,
    headers: { ...headersMap, authorization },
    body: method === 'GET' || bodyBuffer.length === 0 ? undefined : bodyBuffer,
  });
  const text = await response.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Bailian OpenAPI ${input.action} returned non-JSON (HTTP ${response.status}).`);
  }
  if (!response.ok || data?.Success === false || data?.Success === 'false') {
    const code = data?.Code || data?.code || '';
    const requestId = data?.RequestId || data?.requestId || '';
    const message = data?.Message || data?.message || data?.Code || `HTTP ${response.status}`;
    const hint = /authoriz|permission|denied|无权限|没有权限/i.test(String(message))
      ? ' If using a RAM user, grant AliyunBailianDataFullAccess and add the user to the Bailian workspace.'
      : '';
    throw new Error(
      `Bailian OpenAPI ${input.action} failed: ${message}`
      + (code ? ` [${code}]` : '')
      + (requestId ? ` (RequestId: ${requestId})` : '')
      + hint,
    );
  }
  // Some Bailian APIs return HTTP 200 with Status:400 and Code set, without Success=false.
  const topStatus = data?.Status ?? data?.status;
  if ((topStatus === 400 || topStatus === '400') && (data?.Code || data?.Message)) {
    const code = data?.Code || data?.code || '';
    const requestId = data?.RequestId || data?.requestId || '';
    const message = data?.Message || data?.message || code || 'Bad request';
    throw new Error(
      `Bailian OpenAPI ${input.action} failed: ${message}`
      + (code ? ` [${code}]` : '')
      + (requestId ? ` (RequestId: ${requestId})` : ''),
    );
  }
  return data;
}

function clampBailianName(name: string, max = 20) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Knowledge base name is required.');
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

export async function bailianOpenApiRetrieve(input: BailianAuth & {
  indexId: string;
  query: string;
  topK: number;
}) {
  const auth = requireAuth(input);
  const indexId = input.indexId.trim();
  if (!indexId) throw new Error('Bailian IndexId is required.');
  const data = await bailianOpenApiCall({
    ...auth,
    action: 'Retrieve',
    pathname: `/${encodeURIComponent(auth.workspaceId)}/index/retrieve`,
    query: {
      IndexId: indexId,
      Query: input.query,
      DenseSimilarityTopK: Math.min(100, Math.max(1, input.topK)),
      SparseSimilarityTopK: Math.min(100, Math.max(1, input.topK)),
      EnableReranking: true,
      RerankTopN: Math.min(20, Math.max(1, input.topK)),
    },
  });
  const nodes = Array.isArray(data?.Data?.Nodes) ? data.Data.Nodes : [];
  return { nodes, raw: data };
}

export async function bailianOpenApiCreateIndex(input: BailianAuth & {
  name: string;
  description?: string;
  embeddingModelName?: string;
}) {
  const auth = requireAuth(input);
  const name = clampBailianName(input.name);
  const categoryName = clampBailianName(`openclawx-${name}`.replace(/[^\u4e00-\u9fa5a-zA-Z0-9_.:-]/g, '-'));

  const categoryData = await bailianOpenApiCall({
    ...auth,
    action: 'AddCategory',
    pathname: `/${encodeURIComponent(auth.workspaceId)}/datacenter/category/`,
    formBody: { CategoryName: categoryName, CategoryType: 'UNSTRUCTURED' },
  });
  const categoryId = String(categoryData?.Data?.CategoryId || '').trim();
  if (!categoryId) throw new Error('Bailian AddCategory succeeded but returned no CategoryId.');

  const createQuery: Record<string, string | number | boolean | undefined> = {
    Name: name,
    StructureType: 'unstructured',
    SinkType: 'BUILT_IN',
    SourceType: 'DATA_CENTER_CATEGORY',
    CategoryIds: JSON.stringify([categoryId]),
  };
  if (input.description?.trim()) createQuery.Description = input.description.trim().slice(0, 1000);
  if (input.embeddingModelName?.trim()) createQuery.EmbeddingModelName = input.embeddingModelName.trim();

  const indexData = await bailianOpenApiCall({
    ...auth,
    action: 'CreateIndex',
    pathname: `/${encodeURIComponent(auth.workspaceId)}/index/create`,
    query: createQuery,
  });
  const indexId = String(indexData?.Data?.Id || '').trim();
  if (!indexId) throw new Error('Bailian CreateIndex succeeded but returned no Index Id.');
  return { indexId, categoryId, workspaceId: auth.workspaceId, name };
}

export async function bailianOpenApiUpdateIndex(input: BailianAuth & {
  indexId: string;
  name?: string;
  description?: string;
}) {
  const auth = requireAuth(input);
  const indexId = input.indexId.trim();
  if (!indexId) throw new Error('Bailian IndexId is required.');
  await bailianOpenApiCall({
    ...auth,
    action: 'UpdateIndex',
    pathname: `/${encodeURIComponent(auth.workspaceId)}/index/update`,
    query: {
      Id: indexId,
      Name: input.name?.trim() || undefined,
      Description: input.description?.trim() || undefined,
    },
  });
  return { ok: true as const };
}

export async function bailianOpenApiDeleteIndex(input: BailianAuth & { indexId: string }) {
  const auth = requireAuth(input);
  const indexId = input.indexId.trim();
  if (!indexId) throw new Error('Bailian IndexId is required.');
  await bailianOpenApiCall({
    ...auth,
    action: 'DeleteIndex',
    pathname: `/${encodeURIComponent(auth.workspaceId)}/index/delete`,
    query: { IndexId: indexId },
  });
  return { ok: true as const };
}

export async function bailianOpenApiListIndices(input: BailianAuth & {
  pageNumber?: number;
  pageSize?: number;
  indexName?: string;
}) {
  const auth = requireAuth(input);
  const data = await bailianOpenApiCall({
    ...auth,
    method: 'GET',
    action: 'ListIndices',
    pathname: `/${encodeURIComponent(auth.workspaceId)}/index/list_indices`,
    query: {
      IndexName: input.indexName?.trim() || undefined,
      PageNumber: input.pageNumber || 1,
      PageSize: Math.min(50, Math.max(1, input.pageSize || 20)),
    },
  });
  const rows = Array.isArray(data?.Data?.Indices) ? data.Data.Indices
    : Array.isArray(data?.Data?.IndexList) ? data.Data.IndexList
      : Array.isArray(data?.Data) ? data.Data
        : [];
  return rows.map((item: any) => ({
    id: String(item.Id || item.id || ''),
    name: String(item.Name || item.name || ''),
    description: String(item.Description || item.description || ''),
    documentCount: Number(item.DocumentCount ?? item.documentCount ?? 0) || 0,
    categoryId: (() => {
      const raw = item.CategoryIds || item.categoryIds || item.CategoryId || item.categoryId;
      if (Array.isArray(raw) && raw.length) return String(raw[0] || '').trim();
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length) return String(parsed[0] || '').trim();
        } catch {
          return raw.trim();
        }
        return raw.trim();
      }
      return '';
    })(),
  })).filter((item: { id: string }) => item.id);
}

export async function bailianOpenApiListDocuments(input: BailianAuth & {
  indexId: string;
  pageNumber?: number;
  pageSize?: number;
  documentName?: string;
}) {
  const auth = requireAuth(input);
  const indexId = input.indexId.trim();
  if (!indexId) throw new Error('Bailian IndexId is required.');
  const pageNumber = Math.max(1, input.pageNumber || 1);
  const pageSize = Math.min(50, Math.max(1, input.pageSize || 20));
  const data = await bailianOpenApiCall({
    ...auth,
    method: 'GET',
    action: 'ListIndexDocuments',
    pathname: `/${encodeURIComponent(auth.workspaceId)}/index/list_index_documents`,
    query: {
      IndexId: indexId,
      DocumentName: input.documentName?.trim() || undefined,
      PageNumber: pageNumber,
      PageSize: pageSize,
    },
  });
  const rows = Array.isArray(data?.Data?.Documents) ? data.Data.Documents
    : Array.isArray(data?.Data?.DocumentList) ? data.Data.DocumentList
      : [];
  const total = Number(data?.Data?.TotalCount ?? data?.Data?.totalCount ?? rows.length) || rows.length;
  const documents = rows.map((item: any, index: number) => {
    const id = String(item.Id || item.DocumentId || item.id || `doc-${index}`);
    const title = String(item.Name || item.DocumentName || item.name || id);
    const status = String(item.DocumentStatus || item.Status || item.status || '');
    const size = Number(item.Size || item.size || 0) || 0;
    return {
      id,
      title,
      source: status || undefined,
      chunkCount: Number(item.ChunkCount ?? item.chunkCount ?? 0) || 0,
      createdAt: Number(item.GmtModified || item.GmtCreate || Date.now()) || Date.now(),
      preview: size ? `${Math.round(size / 1024)} KB · ${status || 'ready'}` : (status || title),
    };
  });
  return { documents, total, pageNumber, pageSize };
}

export async function bailianOpenApiDeleteDocuments(input: BailianAuth & {
  indexId: string;
  documentIds: string[];
}) {
  const auth = requireAuth(input);
  const indexId = input.indexId.trim();
  const documentIds = input.documentIds.map((id) => id.trim()).filter(Boolean);
  if (!indexId) throw new Error('Bailian IndexId is required.');
  if (!documentIds.length) throw new Error('documentIds are required.');
  await bailianOpenApiCall({
    ...auth,
    action: 'DeleteIndexDocument',
    pathname: `/${encodeURIComponent(auth.workspaceId)}/index/delete_index_document`,
    query: {
      IndexId: indexId,
      DocumentIds: JSON.stringify(documentIds),
    },
  });
  return { ok: true as const, removed: documentIds.length };
}

export async function bailianOpenApiListChunks(input: BailianAuth & {
  indexId: string;
  fileId?: string;
  pageNum?: number;
  pageSize?: number;
}) {
  const auth = requireAuth(input);
  const indexId = input.indexId.trim();
  if (!indexId) throw new Error('Bailian IndexId is required.');
  const pageNum = Math.max(1, input.pageNum || 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize || 40));
  const data = await bailianOpenApiCall({
    ...auth,
    action: 'ListChunks',
    pathname: `/${encodeURIComponent(auth.workspaceId)}/index/list_chunks`,
    jsonBody: {
      IndexId: indexId,
      FileId: input.fileId?.trim() || undefined,
      PageNum: pageNum,
      PageSize: pageSize,
    },
  });
  const rows = Array.isArray(data?.Data?.Nodes) ? data.Data.Nodes
    : Array.isArray(data?.Data?.Chunks) ? data.Data.Chunks
      : Array.isArray(data?.Data) ? data.Data
        : [];
  const total = Number(data?.Data?.TotalCount ?? data?.Data?.totalCount ?? rows.length) || rows.length;
  const chunks = rows.map((item: any, index: number) => {
    let metadata = item.Metadata ?? item.metadata ?? {};
    if (typeof metadata === 'string') {
      try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
    }
    const content = String(item.Text || item.text || item.Content || item.content || metadata?.content || '');
    const documentId = String(metadata?.doc_id || metadata?.file_id || item.FileId || item.fileId || '');
    const documentTitle = String(metadata?.doc_name || metadata?.title || documentId || 'document');
    return {
      id: String(item.Id || item.id || metadata?.nid || metadata?._id || `chunk-${index}`),
      documentId: documentId || 'unknown',
      documentTitle,
      title: String(metadata?.title || metadata?.hier_title || documentTitle),
      content,
      source: String(metadata?.file_path || metadata?.url || '') || undefined,
      createdAt: Date.now(),
    };
  }).filter((item: { content: string }) => item.content);
  return { chunks, total, pageNum, pageSize };
}

export async function bailianOpenApiDeleteChunks(input: BailianAuth & {
  indexId: string;
  chunkIds: string[];
}) {
  const auth = requireAuth(input);
  const indexId = input.indexId.trim();
  const chunkIds = input.chunkIds.map((id) => id.trim()).filter(Boolean).slice(0, 10);
  if (!indexId) throw new Error('Bailian IndexId is required.');
  if (!chunkIds.length) throw new Error('chunkIds are required.');
  await bailianOpenApiCall({
    ...auth,
    action: 'DeleteChunk',
    pathname: `/${encodeURIComponent(auth.workspaceId)}/chunk/delete`,
    jsonBody: {
      PipelineId: indexId,
      ChunkIds: chunkIds,
    },
  });
  return { ok: true as const, removed: chunkIds.length };
}

function md5Hex(bytes: Buffer) {
  return createHash('md5').update(bytes).digest('hex');
}

/** Upload a file into Bailian category and attach it to an index (async job). */
export async function bailianOpenApiUploadDocument(input: BailianAuth & {
  indexId: string;
  categoryId: string;
  fileName: string;
  bytes: Buffer;
  parser?: string;
}) {
  const auth = requireAuth(input);
  const indexId = input.indexId.trim();
  const categoryId = input.categoryId.trim();
  const fileName = input.fileName.trim() || 'document.txt';
  if (!indexId) throw new Error('Bailian IndexId is required.');
  if (!categoryId) throw new Error('Bailian categoryId is required for upload. Recreate the knowledge base or set categoryId.');
  if (!input.bytes?.length) throw new Error('File content is empty.');

  const leaseData = await bailianOpenApiCall({
    ...auth,
    action: 'ApplyFileUploadLease',
    pathname: `/${encodeURIComponent(auth.workspaceId)}/datacenter/category/${encodeURIComponent(categoryId)}`,
    formBody: {
      FileName: fileName,
      Md5: md5Hex(input.bytes),
      SizeInBytes: String(input.bytes.length),
      CategoryType: 'UNSTRUCTURED',
    },
  });
  const lease = leaseData?.Data || {};
  const leaseId = String(lease.FileUploadLeaseId || lease.LeaseId || '').trim();
  const param = lease.Param || lease.param || {};
  const uploadUrl = String(param.Url || param.url || '').trim();
  const uploadMethod = String(param.Method || param.method || 'PUT').toUpperCase();
  const uploadHeaders = (param.Headers || param.headers || {}) as Record<string, unknown>;
  if (!leaseId || !uploadUrl) throw new Error('Bailian ApplyFileUploadLease returned incomplete lease data.');

  // Lease headers must be sent exactly (including empty Content-Type). Overriding breaks OSS signature → HTTP 403.
  const ossHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(uploadHeaders || {})) {
    ossHeaders[key] = value == null ? '' : String(value);
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: uploadMethod === 'POST' ? 'POST' : 'PUT',
    headers: ossHeaders,
    body: new Uint8Array(input.bytes),
  });
  if (!uploadResponse.ok) {
    const errText = await uploadResponse.text().catch(() => '');
    throw new Error(`Bailian OSS upload failed (HTTP ${uploadResponse.status}): ${errText.slice(0, 200)}`);
  }

  const addData = await bailianOpenApiCall({
    ...auth,
    method: 'PUT',
    action: 'AddFile',
    pathname: `/${encodeURIComponent(auth.workspaceId)}/datacenter/file`,
    formBody: {
      CategoryId: categoryId,
      LeaseId: leaseId,
      // Request enum per OpenAPI; DASHSCOPE_DOCMIND is a response value, not a request parser id.
      Parser: input.parser || 'AUTO_SELECT',
    },
  });
  const fileId = String(addData?.Data?.FileId || addData?.Data?.Id || '').trim();
  if (!fileId) throw new Error('Bailian AddFile succeeded but returned no FileId.');

  const jobData = await bailianOpenApiCall({
    ...auth,
    action: 'SubmitIndexAddDocumentsJob',
    pathname: `/${encodeURIComponent(auth.workspaceId)}/index/add_documents_to_index`,
    query: {
      IndexId: indexId,
      SourceType: 'DATA_CENTER_FILE',
      DocumentIds: JSON.stringify([fileId]),
    },
  });
  const jobId = String(jobData?.Data?.Id || jobData?.Data?.JobId || '').trim();
  return {
    ok: true as const,
    documentId: fileId,
    jobId: jobId || undefined,
    status: 'queued' as const,
    fileName,
    bytes: input.bytes.length,
  };
}

export async function bailianOpenApiGetJobStatus(input: BailianAuth & {
  indexId: string;
  jobId: string;
}) {
  const auth = requireAuth(input);
  const indexId = input.indexId.trim();
  const jobId = input.jobId.trim();
  if (!indexId || !jobId) throw new Error('indexId and jobId are required.');
  const data = await bailianOpenApiCall({
    ...auth,
    method: 'GET',
    action: 'GetIndexJobStatus',
    pathname: `/${encodeURIComponent(auth.workspaceId)}/index/job/status`,
    query: { IndexId: indexId, JobId: jobId },
  });
  return {
    status: String(data?.Data?.Status || data?.Data?.status || 'UNKNOWN'),
    documents: Array.isArray(data?.Data?.Documents) ? data.Data.Documents : [],
    raw: data,
  };
}
