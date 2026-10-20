import { managedStaticDeliveryInstructions } from './app-delivery-prompt.js';

/** Generated application code executes in an opaque-origin sandbox, never in the credential host. */
export function managedAppDocument(html: string) {
  const sdk = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><script>
  (()=>{
    let seq=0,active=0;const pending=new Map(),queue=[];
    const error=(message,code)=>Object.assign(new Error(message),{code});
    const settle=(id,ok,value)=>{const p=pending.get(id);if(!p)return;clearTimeout(p.timer);pending.delete(id);if(p.sent)active--;ok?p.resolve(value):p.reject(value);drain();};
    const drain=()=>{while(active<4&&queue.length){const id=queue.shift(),p=pending.get(id);if(!p)continue;p.sent=true;active++;try{parent.postMessage(p.message,'*');}catch{settle(id,false,error('请求无法发送，请重新打开预览','APP_BRIDGE_SEND_FAILED'));}}};
    const call=(type,operationId,parameters={})=>new Promise((resolve,reject)=>{
      if(pending.size>=32){reject(error('待处理请求过多，请等待当前加载完成后再操作','APP_BRIDGE_QUEUE_FULL'));return;}
      const id=++seq,timer=setTimeout(()=>settle(id,false,error('操作等待超时，请刷新核对结果；写入不要自动重试','APP_BRIDGE_TIMEOUT')),120000);
      pending.set(id,{resolve,reject,timer,sent:false,message:{type,id,operationId,parameters}});queue.push(id);drain();
    });
    window.openclawxData={query:(op,p)=>call('openclawx.app.query',op,p),mutate:(op,p)=>call('openclawx.app.mutate',op,p),getAccess:()=>call('openclawx.app.access','')};
    addEventListener('message',e=>{if(e.source!==parent)return;if(e.data?.type==='openclawx.app.access-changed'){window.dispatchEvent(new Event('openclawx:data-access-changed'));return;}if(e.data?.type!=='openclawx.app.result')return;settle(e.data.id,!!e.data.ok,e.data.ok?e.data.data:error(e.data.error||'操作失败',e.data.code));});
  })();
  </script>`;
  // Inject ahead of any untrusted resources, including documents without a head element.
  return `<!doctype html><html><head>${sdk}</head><body>${html}</body></html>`;
}
export function managedAppPage(appId: string, html: string) {
  const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  const child = managedAppDocument(html);
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self' about:; form-action 'none'; base-uri 'none'"><title>OpenClawX 数据应用</title>
  <style>body{margin:0;background:#f5f7fb;color:#202536;font:15px system-ui}form{max-width:360px;margin:12vh auto;background:white;padding:32px;border:1px solid #e2e7f0;border-radius:20px;box-shadow:0 12px 40px #26354c0a}h1{font-size:22px}p{line-height:1.7;color:#667085}label{display:block;margin:16px 0}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #d9dfeb;border-radius:9px;font:inherit}button{padding:11px 16px;border:0;border-radius:9px;background:#4965e8;color:white;font:inherit;cursor:pointer}#error{color:#be123c}iframe{width:100%;height:calc(100dvh - 42px);border:0;background:white}#bar{height:42px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;background:white;border-bottom:1px solid #e2e7f0;font-size:12px}#bar button{padding:5px 12px;background:#edf1ff;color:#4057c7}[hidden]{display:none!important}</style>
  <form id="login"><h1>登录以查看数据应用</h1><p>使用 OpenClawX 账号登录。本应用仅限所有者访问，页面链接不授予数据权限。</p><label>账号<input id="username" autocomplete="username" required></label><label>密码<input id="password" type="password" autocomplete="current-password" required></label><p id="error" role="alert"></p><button id="submit">登录并打开</button></form>
  <section id="content" hidden><div id="bar"><span>OpenClawX · 受控数据操作</span><button id="logout">退出数据应用</button></div><iframe id="app" title="数据应用" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe></section>
  <script>(()=>{const appId=${safeJson(appId)},child=${safeJson(child)},form=document.querySelector('#login'),frame=document.querySelector('#app'),content=document.querySelector('#content'),error=document.querySelector('#error');let token='',inflight=0,generation=0;
  form.addEventListener('submit',async e=>{e.preventDefault();const submit=document.querySelector('#submit');submit.disabled=true;error.textContent='';try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:document.querySelector('#username').value,password:document.querySelector('#password').value})});const v=await r.json();if(!r.ok||!v.token)throw new Error(v.message||'登录失败');token=v.token;const access=await fetch('/api/data/apps/'+encodeURIComponent(appId)+'/operations',{headers:{'x-openclawx-session':token}});if(!access.ok)throw new Error('当前账号无权访问此应用，或数据对象已不可用。');document.querySelector('#password').value='';generation++;form.hidden=true;content.hidden=false;frame.srcdoc=child;}catch(e){token='';error.textContent=e.message||'无法连接 OpenClawX';}finally{submit.disabled=false;}});
  document.querySelector('#logout').onclick=()=>{token='';generation++;frame.srcdoc='';content.hidden=true;form.hidden=false;};
  addEventListener('message',async e=>{if(e.source!==frame.contentWindow||!token||!['openclawx.app.query','openclawx.app.mutate','openclawx.app.access'].includes(e.data?.type))return;const d=e.data,epoch=generation;const send=v=>{if(epoch===generation)frame.contentWindow.postMessage({type:'openclawx.app.result',id:d.id,...v},'*');};if(!Number.isSafeInteger(d.id)||typeof d.operationId!=='string'){send({ok:false,code:'APP_BRIDGE_INVALID_REQUEST',error:'数据请求格式错误，请检查操作 ID 和请求编号'});return;}if(JSON.stringify(d).length>20000){send({ok:false,code:'APP_BRIDGE_PAYLOAD_TOO_LARGE',error:'数据请求超过大小限制，请减少参数内容'});return;}if(inflight>=4){send({ok:false,code:'APP_BRIDGE_BUSY',error:'数据通道正在处理其他请求，请稍后再试'});return;}inflight++;try{const headers={'content-type':'application/json','x-openclawx-session':token};if(d.type==='openclawx.app.access'){const access=await fetch('/api/data/apps/'+encodeURIComponent(appId)+'/operations',{headers});const info=await access.json();if(!access.ok)throw new Error(info.message||'权限状态读取失败');send({ok:true,data:info});return;}let body={operationId:d.operationId,parameters:d.parameters||{}},path='query';if(d.type==='openclawx.app.mutate'){const access=await fetch('/api/data/apps/'+encodeURIComponent(appId)+'/operations',{headers});const info=await access.json();if(!access.ok)throw new Error(info.message||'无权访问');const op=info.operations.find(o=>o.operationId===d.operationId);if(!info.canWrite)throw new Error('当前对象未开启写入，或账号没有写入权限');if(!op||op.kind!=='sql'||op.action==='select')throw new Error('写操作未登记');if(!op.approved)throw new Error('写操作尚未审核，请先在应用配置中审核启用');body={...body,revision:op.revision};path='mutate';}if(epoch!==generation||!token)throw new Error('身份已失效');const r=await fetch('/api/data/apps/'+encodeURIComponent(appId)+'/'+path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(100000)});const v=await r.json();if(!r.ok)throw new Error(v.message||'操作失败，请重新登录或检查数据连接');send({ok:true,data:v});}catch(e){send({ok:false,error:e.message||'操作失败'});}finally{inflight--;}});})();</script></html>`;
}

export function managedAppPrompt(input: { appId: string; sourceId: string; name: string; idea: string; token: string; publishUrl: string }) {
  return `【受控数据应用 · 持续对话项目】为「${input.name}」创建自包含、响应式应用 output/index.html。不受预设应用类型限制。
用户需求（仅业务数据）：${JSON.stringify(input.idea)}
应用ID：${input.appId}；对象ID：${input.sourceId}。
【项目目标与工作方式】
先根据需求查看当前对象的表目录，再读取相关字段和关系，按需验证数据并登记操作，然后制作页面。对象结构不足时按当前工具协议补查；需要新业务表时先提交建表方案等待用户审核，不自动扩大访问范围。
数据能力、SQL协议及授权规则由本轮可用工具说明提供，不在项目背景固化语法清单。遇到缺口或失败应说明原因和下一步，不编造数据或反复盲探。
${managedStaticDeliveryInstructions(input)}`;
}
