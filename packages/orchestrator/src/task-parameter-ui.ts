import type { TaskParameterUi } from '@workmate/contracts';
import { parameterValidator } from '@workmate/contracts';

export function validateParameterUi(ui: TaskParameterUi) {
  const validator = parameterValidator(JSON.parse(ui.files['input.schema.json']));
  const html = ui.files['index.html'];
  if (!/platform\.submit|workmate\.task\.submit/.test(Object.values(ui.files).join('\n'))) throw new Error('参数页面必须调用 platform.submit(parameters)');
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const ref = match[1].replace(/^\.\//, '');
    if (/^(#|data:)/.test(ref)) continue;
    if (!ui.files[ref]) throw new Error(`参数页面引用了未打包的资源：${ref}`);
  }
  return validator;
}
const scriptSafe = (s: string) => s.replace(/<\/script/gi, '<\\/script');
/** Bundle without granting origin privileges or network access. Host mediates documented queries. */
export function parameterUiHtml(ui: TaskParameterUi) {
  validateParameterUi(ui);
  let html = ui.files['index.html'].replace(/<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, '');
  html = html.replace(/<link\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi, (_tag, name) => `<style>${ui.files[name.replace(/^\.\//,'')]?.replace(/<\/style/gi, '<\\/style') ?? ''}</style>`);
  html = html.replace(/<script\b([^>]*)src\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (_tag, _a, name) => `<script>${scriptSafe(ui.files[name.replace(/^\.\//,'')] ?? '')}</script>`);
  const sdk = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><script>
let taskChannel='',taskParameters={},taskSubmitLabel='确认参数';const taskPending=new Map();let taskReadyResolve;const taskReady=new Promise(r=>taskReadyResolve=r);
window.platform={ready:taskReady,getParameters:()=>structuredClone(taskParameters),getSubmitLabel:()=>taskSubmitLabel,
submit:async parameters=>{await taskReady;parent.postMessage({type:'workmate.task.submit',channel:taskChannel,parameters},'*')},
request:async(path,query={})=>{await taskReady;const id=crypto.randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{taskPending.delete(id);reject(new Error('数据查询超时'))},15000);taskPending.set(id,{resolve,reject,timer});parent.postMessage({type:'workmate.task.request',channel:taskChannel,id,path,query},'*')})}};
window.addEventListener('message',e=>{if(e.source!==parent)return;const m=e.data;if(m?.type==='workmate.task.init'){taskChannel=m.channel;taskParameters=m.parameters||{};taskSubmitLabel=m.submitLabel||'确认参数';taskReadyResolve();window.dispatchEvent(new CustomEvent('platform:init',{detail:taskParameters}))}if(m?.channel!==taskChannel)return;if(m.type==='workmate.task.response'){const p=taskPending.get(m.id);if(p){clearTimeout(p.timer);taskPending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.data)}}if(m.type==='workmate.task.saved'){window.dispatchEvent(new CustomEvent('platform:saved',{detail:m}));document.getElementById('workmate-feedback').textContent=m.error||m.notice||'参数已确认'}});
document.addEventListener('input',()=>{if(taskChannel)parent.postMessage({type:'workmate.task.dirty',channel:taskChannel},'*')});
// Preserve standard form buttons too; submit handlers run locally without a
// browser form submission or a sandbox permission change.
document.addEventListener('click',event=>{
 const target=event.target?.closest?.('button,input[type="submit"]');
 if(!taskChannel||event.defaultPrevented||!target?.form||target.type!=='submit'||target.disabled)return;
 event.preventDefault();
 if(!target.form.reportValidity()){parent.postMessage({type:'workmate.task.confirm-error',channel:taskChannel,error:'请检查表单中的必填项和填写格式。'},'*');return;}
 target.form.dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:target}));
});
window.addEventListener('message',e=>{
 if(e.source!==parent||e.data?.channel!==taskChannel||!taskChannel||e.data.type!=='workmate.task.confirm')return;
 const buttons=[...document.querySelectorAll('button,input[type="submit"]')].filter(b=>!b.disabled);
 const labelled=buttons.filter(b=>(b.textContent||b.value||'').trim()===taskSubmitLabel);
 const submits=buttons.filter(b=>b.type==='submit'&&b.form);
 const target=labelled.length===1?labelled[0]:labelled.length===0&&submits.length===1?submits[0]:null;
 if(!target){parent.postMessage({type:'workmate.task.confirm-error',channel:taskChannel,error:'未找到唯一的确认按钮，请使用表单内的确认按钮，或在 UI 项目中修正提交按钮。'},'*');return;}
 const form=target.form;
 if(form&&!form.reportValidity()){parent.postMessage({type:'workmate.task.confirm-error',channel:taskChannel,error:'请检查表单中的必填项和填写格式。'},'*');return;}
 // sandbox deliberately omits allow-forms: browser default submission is blocked
 // before page submit handlers. Invoke only the handler event, never navigation.
 if(form&&target.type==='submit')form.dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:target}));
 else target.click();
});
parent.postMessage({type:'workmate.task.ready'},'*');
</script>`;
  html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, tag => tag + sdk) : sdk + html;
  return html + '<p id="workmate-feedback" role="status" style="font:13px system-ui;padding:12px;color:#425788"></p>';
}
