import { BusinessSummaryResultSchema, TaskPresentationSchema, type TaskPresentation } from '@openclawx/contracts';
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}
export function reportHtml(value: unknown, options?: TaskPresentation): string {
  const data = BusinessSummaryResultSchema.parse(value);
  const settings = TaskPresentationSchema.parse(options ?? {});
  const accent = { blue: '#4663e5', green: '#168567', violet: '#8054c7' }[settings.accent];
  const money = (n: number) => n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"><style>body{margin:0;padding:28px;font:14px system-ui;color:#202738;background:#fff}h1{font-size:25px;margin:8px 0}p{color:#667085;line-height:1.8}.eyebrow{color:${accent};font-size:12px;letter-spacing:2px}.metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:24px 0}.metric{background:#f5f7fc;padding:18px;border-radius:12px}.metric span{display:block;color:#667085;margin-bottom:8px}.metric strong{font-size:25px}table{width:100%;border-collapse:collapse}td,th{text-align:right;padding:12px 8px;border-bottom:1px solid #e6eaf1}td:first-child,th:first-child{text-align:left}.note{font-size:12px;margin-top:25px}</style></head><body>
<div class="eyebrow">OPENCLAWX / BUSINESS REPORT</div><h1>${escapeHtml(data.period)} ${escapeHtml(settings.title || '经营数据汇总')}</h1>${settings.showSummary ? `<p>${escapeHtml(data.summary)}</p>` : ''}
<div class="metrics">${[['收入', money(data.revenue)], ['成本', money(data.cost)], ['利润', money(data.profit)], ['利润率', data.margin === null ? '—' : (data.margin * 100).toFixed(2) + '%']].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>
${settings.showRows ? `<h2>业务明细</h2><table><thead><tr><th>业务 / 区域</th><th>收入</th><th>成本</th><th>利润</th></tr></thead><tbody>${data.rows.map(row => `<tr><td>${escapeHtml(row.name)}</td><td>${money(row.revenue)}</td><td>${money(row.cost)}</td><td>${money(row.profit)}</td></tr>`).join('')}</tbody></table>` : ''}
<p class="note">币种：CNY · 金额单位：元。利润为录入收入减成本，不等同于净利润。零收入不计算利润率。本报告基于本次运行的输入快照生成。</p></body></html>`;
}
