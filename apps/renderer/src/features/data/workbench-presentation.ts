import type { DataApp, DataSource } from '../../services/api';

export type AppSort = 'updated' | 'created' | 'name';
export function appAccessUrl(app: DataApp, lan = false) {
  const values=lan ? [app.lanUrl,...app.lanUrls || []] : [app.publishUrl,app.lanUrl,...app.lanUrls || []];
  for(const value of values){
    try { const url=new URL(value || ''); if(/^https?:$/.test(url.protocol) && !(lan && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))return url.href; } catch { /* Ignore unavailable link candidates. */ }
  }
  return '';
}
export function galleryApps(apps: DataApp[], search = '', sort: AppSort = 'updated') {
  const term=search.trim().toLocaleLowerCase();
  return sortDataApps(apps.filter(app => app.published && !appPresentation(app).pending && appAccessUrl(app)
    && (!term || `${app.name} ${app.appType}`.toLocaleLowerCase().includes(term))),sort);
}
const timestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
export function appModifiedAt(app: Pick<DataApp, 'createdAt' | 'customSite'>) {
  return timestamp(app.customSite?.updatedAt) || timestamp(app.createdAt);
}
export function sortDataApps(apps: DataApp[], sort: AppSort = 'updated') {
  return [...apps].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : sort === 'created' ? timestamp(b.createdAt) - timestamp(a.createdAt) : appModifiedAt(b) - appModifiedAt(a))
    || timestamp(b.createdAt) - timestamp(a.createdAt) || a.id.localeCompare(b.id));
}
export function formatAppTime(value: unknown) {
  const time = timestamp(value);
  return time ? new Date(time).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '暂无记录';
}

// Only presentation of server facts; never infer an Agent's execution state.
export function appPresentation(app: Pick<DataApp, 'delivery' | 'customSite'>) {
  const pending = app.delivery?.status === 'awaiting-binding';
  return {
    pending,
    label: pending ? '待交付' : app.customSite?.bound ? '定制应用 · 可用' : '模板应用 · 可用',
    primary: pending ? '继续创建' : '打开应用',
    canShare: !pending,
  };
}

export function matchesSource(source: Pick<DataSource, 'name' | 'fileType' | 'summary' | 'annotations'>, query: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = [source.name, source.fileType, source.summary, source.annotations?.description, source.annotations?.connectionDescription].join(' ').toLocaleLowerCase();
  return words.every(word => text.includes(word));
}

export function sourceNextStep(hasDescription: boolean, annotated: number, total: number) {
  if (!hasDescription) return { action: 'description', label: '补充业务说明', note: '告诉 AI 这份数据的用途和统计口径。也可以直接创建应用。' };
  if (annotated < total) return { action: 'fields', label: '补充字段说明', note: `已标注 ${annotated} / ${total} 个字段。补充关键字段含义可帮助 AI 理解数据。` };
  return { action: 'create', label: '创建应用', note: '说明已准备好。描述你的需求，在专属项目中制作应用。' };
}
