import {TaskReportUiSchema,type TaskReportUi} from '@openclawx/contracts';
import {Script} from 'node:vm';

/** Task reports receive only their immutable result. No authenticated data bridge. */
export function validateReportUi(ui:TaskReportUi) {
  TaskReportUiSchema.parse(ui);
  for(const match of ui.files['index.html'].matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const ref=match[1].replace(/^\.\//,'');
    if(!/^(#|data:)/.test(ref)&&!ui.files[ref])throw Error(`任务报告引用了未打包的资源：${ref}`);
  }
  try {
    for(const [name,source] of Object.entries(ui.files))if(name.endsWith('.js'))new Script(source);
    for(const match of ui.files['index.html'].matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if(/\btype\s*=/.test(match[1])&&!/\btype\s*=\s*["'](?:text|application)\/javascript["']/i.test(match[1]))throw Error('仅支持普通 JavaScript 脚本');
      if(!/\bsrc\s*=/.test(match[1]))new Script(match[2]);
    }
  }catch{throw Error('任务报告脚本语法无效，请在编辑器修正（仅支持普通 JavaScript，不支持模块导入）');}
}
const scriptSafe=(s:string)=>s.replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
export const defaultReportSource=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px system-ui;color:#202637;background:#f7f8fc;margin:0;padding:24px}main{max-width:900px;margin:auto;background:white;padding:24px;border:1px solid #e2e6ef;border-radius:14px}h1{font-size:22px;margin:0 0 16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}p{color:#68748b}</style></head><body><main><h1 id="title">任务报告</h1><p id="empty"></p><pre id="content"></pre></main><script>platform.ready.then(()=>{const result=platform.getResult();document.getElementById('title').textContent=result.title||'任务报告';document.getElementById('empty').textContent=result.preview?'设计预览 · 示例数据，不是真实运行结果':'';const data=result.data;document.getElementById('content').textContent=typeof data?.text==='string'?data.text:JSON.stringify(data??{},null,2);});</script></body></html>`;
export function reportUiHtml(ui:TaskReportUi|undefined,result:Record<string,unknown>) {
  if(ui)validateReportUi(ui);
  const files=ui?.files??{};
  let html=(ui?.files['index.html']??defaultReportSource).replace(/<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi,'');
  html=html.replace(/<link\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi,(_tag,name)=>`<style>${files[name.replace(/^\.\//,'')]?.replace(/<\/style/gi,'<\\/style')??''}</style>`);
  html=html.replace(/<script\b[^>]*src\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi,(_tag,name)=>`<script>${(files[name.replace(/^\.\//,'')]??'').replace(/<\/script/gi,'<\\/script')}</script>`);
  const sdk=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><script>window.platform={ready:Promise.resolve(),getResult:()=>JSON.parse(${scriptSafe(JSON.stringify(JSON.stringify(result)))})};const reportFallback=()=>{const show=()=>{if(document.getElementById('task-report-fallback'))return;const box=document.createElement('section');box.id='task-report-fallback';box.setAttribute('role','alert');box.style.cssText='position:relative;padding:20px;background:white;color:#202637;font:14px system-ui';const title=document.createElement('h2');title.textContent='报告界面显示失败，以下为原始结果';const content=document.createElement('pre');content.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';content.textContent=JSON.stringify(platform.getResult().data??{},null,2);box.append(title,content);document.body.prepend(box)};if(document.body)show();else document.addEventListener('DOMContentLoaded',show,{once:true})};window.addEventListener('error',reportFallback);window.addEventListener('unhandledrejection',reportFallback);</script>`;
  return /<head\b[^>]*>/i.test(html)?html.replace(/<head\b[^>]*>/i,tag=>tag+sdk):sdk+html;
}
export const reportPreviewResult={title:'任务报告预览',preview:true,data:{text:'此处展示任务完成后的结果内容。可在编辑器中设计摘要、指标、表格和图表；真实数据将在运行后注入。'}};
