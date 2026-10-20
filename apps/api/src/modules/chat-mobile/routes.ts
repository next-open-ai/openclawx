import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { OrcEvent } from '@openclawx/orchestrator';
import { requireAuth } from '../auth/service.js';
import type { AuthPrincipal } from '../auth/service.js';
import { canReadOwnedResource, canWriteOwnedResource } from '../auth/ownership.js';
import { getOrchestrator } from '../orchestration/routes.js';
import { createBoundRealtimeVoice, releaseBoundRealtimeVoice } from '../voice/realtime-routes.js';
import { readRealtimeVoiceSettings } from '../voice/settings.js';
import { mobilePublicOrigin, registerMobileVoice } from './voice.js';
import { mobileCallButton, mobileCallSheet, mobileVoiceScript, mobileVoiceStyle } from './voice-ui.js';

const require = createRequire(import.meta.url);

type SqlDatabase = {
  exec: (sql: string, params?: unknown[]) => Array<{ values?: unknown[][] }>;
  run: (sql: string, params?: unknown[]) => void;
  export: () => Uint8Array;
};

let dbPromise: Promise<SqlDatabase> | null = null;

function dataDir() {
  return process.env.OPENCLAWX_DATA_DIR || path.join(os.homedir(), '.openclawx');
}

function databaseFile() {
  return path.join(dataDir(), 'chat-mobile.sqlite');
}

function apiListenPort() {
  return Number(process.env.OPENCLAWX_API_PORT || 47832);
}

const MOBILE_DESKTOP_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

function desktopUploadDirectory() {
  const candidates = [path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Documents')];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
      fs.accessSync(candidate, fs.constants.W_OK);
      return candidate;
    } catch { /* try the next standard user directory */ }
  }
  throw new Error('电脑的下载和文档目录均不可写。');
}

function safeUploadName(value: unknown) {
  const base = path.basename(String(value || 'file')).replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').trim();
  const cleaned = base.replace(/^\.+$/, '').slice(0, 180);
  return cleaned || `mobile-file-${Date.now()}`;
}

function uniqueUploadPath(directory: string, fileName: string) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = path.join(directory, index ? `${stem} (${index})${extension}` : fileName);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('同名文件过多，请修改文件名后重试。');
}

function listLanIPv4Addresses() {
  const out: string[] = [];
  const nics = os.networkInterfaces();
  for (const entries of Object.values(nics)) {
    if (!entries) continue;
    for (const entry of entries) {
      const family = String(entry.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (entry.internal) continue;
      if (entry.address) out.push(entry.address);
    }
  }
  return [...new Set(out)];
}

async function database() {
  if (!dbPromise) {
    dbPromise = (async () => {
      fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
      const sqlJsRoot = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
      const initSqlJs = require(path.join(sqlJsRoot, 'sql-wasm.js'));
      const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(sqlJsRoot, 'sql-wasm.wasm')) });
      const db = new SQL.Database(fs.existsSync(databaseFile()) ? fs.readFileSync(databaseFile()) : undefined) as SqlDatabase;
      db.run(
        'CREATE TABLE IF NOT EXISTS chat_mobile_links (token TEXT PRIMARY KEY, session_id TEXT NOT NULL, org_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
      );
      db.run('CREATE INDEX IF NOT EXISTS chat_mobile_links_session ON chat_mobile_links(session_id, expires_at DESC)');
      flushDatabase(db);
      return db;
    })();
  }
  return dbPromise;
}

function flushDatabase(db: SqlDatabase) {
  fs.writeFileSync(databaseFile(), Buffer.from(db.export()), { mode: 0o600 });
}

type MobileLink = {
  token: string;
  sessionId: string;
  orgId: string;
  ownerUserId: string;
  expiresAt: number;
};

function linkPrincipal(link: Pick<MobileLink, 'ownerUserId' | 'orgId'>): Pick<AuthPrincipal, 'userId' | 'orgId' | 'role'> {
  return { userId: link.ownerUserId, orgId: link.orgId, role: 'member' };
}

async function resolveLink(token: string): Promise<MobileLink | null> {
  const db = await database();
  const row = db.exec(
    'SELECT token, session_id, org_id, owner_user_id, expires_at FROM chat_mobile_links WHERE token = ?',
    [token],
  )[0]?.values?.[0];
  if (!row) return null;
  const expiresAt = Number(row[4] || 0);
  if (!expiresAt || expiresAt < Date.now()) return null;
  return {
    token: String(row[0]),
    sessionId: String(row[1]),
    orgId: String(row[2]),
    ownerUserId: String(row[3]),
    expiresAt,
  };
}

function publicMessages(session: {
  id: string;
  title: string;
  messages: Array<{ id: string; role: string; content: string; createdAt: number; superseded?: boolean; runId?: string }>;
}) {
  return {
    sessionId: session.id,
    title: session.title || '对话',
    messages: session.messages
      .filter((item) => !item.superseded && (item.role === 'user' || item.role === 'assistant'))
      .map((item) => ({
        id: item.id,
        role: item.role,
        content: String(item.content || ''),
        createdAt: item.createdAt,
        runId: item.runId || null,
      })),
  };
}

/**
 * Session message content is only persisted after a run settles. While the
 * model is streaming, live text lives on the run transcript — hydrate it so
 * phone/desktop polls show assistant replies instead of empty bubbles.
 */
async function publicMessagesLive(session: {
  id: string;
  title: string;
  messages: Array<{ id: string; role: string; content: string; createdAt: number; superseded?: boolean; runId?: string }>;
}) {
  const orch = getOrchestrator();
  const payload = publicMessages(session);
  const messages = await Promise.all(
    payload.messages.map(async (item) => {
      if (item.role !== 'assistant' || item.content.trim() || !item.runId) return item;
      const run = await orch.chat.getRun(item.runId).catch(() => null);
      if (!run) return item;
      const live = String(run.transcript || '').trim();
      if (live) return { ...item, content: live };
      if (run.status === 'failed') return { ...item, content: `⚠ ${run.error || '回复失败'}` };
      if (run.status === 'cancelled') return { ...item, content: `⏹ ${run.error || '已中止'}` };
      if (run.status === 'waiting-approval') return { ...item, content: '等待电脑端确认权限…' };
      return item;
    }),
  );
  return { ...payload, messages };
}

export function mobileChatHtml(token: string) {
  const safeToken = JSON.stringify(token);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1">
<meta name="theme-color" content="#0f172a">
<title>OpenClawX 手机对话</title>
<style>
:root{--bg:#0b1220;--panel:#121a2b;--line:#243049;--text:#e8eefc;--muted:#8b97b2;--accent:#3d7eff;--user:#1d4ed8;--bot:#182234;--danger:#ef4444}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:radial-gradient(1200px 600px at 10% -10%,#1a2a4a 0%,var(--bg) 55%);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.app{min-height:100%;display:flex;flex-direction:column;max-width:720px;margin:0 auto}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;padding:14px 16px calc(10px + env(safe-area-inset-top));background:rgba(11,18,32,.88);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.mark{width:36px;height:36px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(145deg,#3d7eff,#22c1c3);font-weight:800;font-size:13px;flex-shrink:0}
.top h1{margin:0;font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top p{margin:2px 0 0;font-size:11px;color:var(--muted)}
.new{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:12px;height:36px;padding:0 12px;font-size:12px;font-weight:700;white-space:nowrap}
.uploadToggle{border:0;background:transparent;color:#aab7d2;border-radius:10px;height:36px;padding:0 8px;font-size:12px;font-weight:700;white-space:nowrap}.uploadToggle:hover{background:var(--panel);color:var(--text)}
.uploadPanel{margin:10px 14px 0;padding:14px;border:1px solid var(--line);border-radius:16px;background:var(--panel);box-shadow:0 16px 36px #0004}.uploadHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.uploadHead strong{font-size:14px}.uploadHead p{margin:2px 0 0;color:var(--muted);font-size:11px}.uploadClose{border:0;background:transparent;color:var(--muted);font-size:20px;line-height:1}.pick{display:flex;align-items:center;justify-content:center;margin-top:12px;min-height:46px;border:1px dashed #4f6388;border-radius:12px;background:#0f1727;color:#cbd7ef;font-size:13px;font-weight:700}.pick input{position:absolute;opacity:0;pointer-events:none}.uploadFile{margin-top:9px;color:var(--muted);font-size:11px;word-break:break-all}.uploadAction{width:100%;height:40px;margin-top:10px;border:0;border-radius:11px;background:var(--accent);color:#fff;font-weight:700}.uploadAction:disabled{opacity:.42}.uploadBar{height:5px;margin-top:10px;overflow:hidden;border-radius:99px;background:#26324a}.uploadBar i{display:block;width:0;height:100%;background:linear-gradient(90deg,#3d7eff,#22c1c3);transition:width .2s}.uploadStatus{min-height:18px;margin-top:8px;color:var(--muted);font-size:11px}.uploadStatus.ok{color:#5ee0a0}.uploadStatus.bad{color:#fda4af}
.list{flex:1;overflow:auto;padding:16px 14px 12px;display:flex;flex-direction:column;gap:10px}
.bubble{max-width:88%;padding:12px 14px;border-radius:18px;white-space:pre-wrap;word-break:break-word;font-size:15px}
.bubble.user{align-self:flex-end;background:var(--user);border-bottom-right-radius:6px}
.bubble.assistant{align-self:flex-start;background:var(--bot);border:1px solid var(--line);border-bottom-left-radius:6px}
.bubble.meta{align-self:center;background:transparent;color:var(--muted);font-size:12px;padding:4px 8px}
.typing{display:inline-flex;gap:4px}.typing i{width:6px;height:6px;border-radius:50%;background:#7f8eab;animation:b 1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}@keyframes b{0%,80%,100%{opacity:.25}40%{opacity:1}}
.composer{position:sticky;bottom:0;padding:10px 12px calc(12px + env(safe-area-inset-bottom));background:rgba(11,18,32,.94);border-top:1px solid var(--line);display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:end}
textarea{width:100%;min-height:44px;max-height:120px;resize:none;border:1px solid var(--line);border-radius:16px;background:var(--panel);color:var(--text);padding:12px 14px;font:inherit;outline:none}
textarea:focus{border-color:#3d7eff88}
button.send,button.stop{border:0;border-radius:14px;padding:0 16px;height:44px;font-weight:700;font-size:14px}
.send{background:var(--accent);color:#fff}.send:disabled{opacity:.45}
.stop{background:#2a3348;color:#dbe4ff}
.err{color:#fecaca;background:#7f1d1d55;border:1px solid #ef444466;border-radius:12px;padding:10px 12px;margin:0 14px 10px;font-size:13px}
${mobileVoiceStyle}
</style>
</head>
<body>
<div class="app">
  <header class="top">
    <div class="mark">W</div>
    <div style="min-width:0;flex:1">
      <h1 id="title">OpenClawX</h1>
      <p id="meta">手机端轻量对话 · 与电脑同步</p>
    </div>
    <button class="uploadToggle" id="uploadToggle" type="button">传文件</button>
    <button class="new" id="newSession" type="button">新对话</button>
  </header>
  <div id="err" class="err" hidden></div>
  <section id="uploadPanel" class="uploadPanel" hidden>
    <div class="uploadHead"><div><strong>传文件到电脑</strong><p>默认保存到电脑的“下载”目录</p></div><button id="uploadClose" class="uploadClose" type="button" aria-label="关闭">×</button></div>
    <label class="pick" for="uploadFile">选择手机中的文件<input id="uploadFile" type="file"></label>
    <div id="uploadName" class="uploadFile">支持任意文件，最大 20 MB</div>
    <button id="uploadSend" class="uploadAction" type="button" disabled>上传到电脑</button>
    <div class="uploadBar"><i id="uploadProgress"></i></div>
    <div id="uploadStatus" class="uploadStatus">等待选择文件</div>
  </section>
  <main id="list" class="list"></main>
  <form class="composer" id="form">
    <textarea id="input" rows="1" placeholder="说点什么…" enterkeyhint="send"></textarea>
    ${mobileCallButton}
    <button class="stop" id="stop" type="button" hidden>停止</button>
    <button class="send" id="send" type="submit">发送</button>
  </form>
</div>
${mobileCallSheet}
<script>
const token=${safeToken};
const list=document.getElementById('list');
const titleEl=document.getElementById('title');
const metaEl=document.getElementById('meta');
const input=document.getElementById('input');
const send=document.getElementById('send');
const stop=document.getElementById('stop');
const err=document.getElementById('err');
const form=document.getElementById('form');
const newSession=document.getElementById('newSession');
const uploadToggle=document.getElementById('uploadToggle');
const uploadPanel=document.getElementById('uploadPanel');
const uploadClose=document.getElementById('uploadClose');
const uploadFile=document.getElementById('uploadFile');
const uploadName=document.getElementById('uploadName');
const uploadSend=document.getElementById('uploadSend');
const uploadProgress=document.getElementById('uploadProgress');
const uploadStatus=document.getElementById('uploadStatus');
let busy=false;
let lastFingerprint='';
let selectedUpload=null;

function showError(message){err.hidden=!message;err.textContent=message||'';}
function scrollBottom(){list.scrollTop=list.scrollHeight;}
function render(payload){
  const messages=payload.messages||[];
  const fingerprint=messages.map(m=>m.id+':'+(m.content||'').length+':'+(m.content||'').slice(-24)).join('|')+(busy?'1':'0')+(payload.title||'');
  if(fingerprint===lastFingerprint) return;
  lastFingerprint=fingerprint;
  titleEl.textContent=payload.title||'对话';
  list.innerHTML='';
  if(!messages.length){
    const empty=document.createElement('div');
    empty.className='bubble meta';
    empty.textContent='开始一条新消息，结果会同步到电脑。';
    list.appendChild(empty);
  }
  for(const message of messages){
    const el=document.createElement('div');
    el.className='bubble '+(message.role==='user'?'user':'assistant');
    el.textContent=message.content||(message.role==='assistant'?'…':'');
    list.appendChild(el);
  }
  if(busy){
    const last=messages[messages.length-1];
    if(!(last&&last.role==='assistant'&&String(last.content||'').trim())){
      const tip=document.createElement('div');
      tip.className='bubble assistant';
      tip.innerHTML='<span class="typing"><i></i><i></i><i></i></span>';
      list.appendChild(tip);
    }
  }
  scrollBottom();
}

async function load(){
  const response=await fetch('/api/chat-mobile/'+encodeURIComponent(token)+'/state');
  const body=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(body.message||'无法加载对话');
  busy=Boolean(body.busy);
  stop.hidden=!busy;
  send.disabled=busy;
  newSession.disabled=busy||!document.getElementById('callSheet').hidden;
  metaEl.textContent=busy?'正在回复…':'手机端轻量对话 · 与电脑同步';
  render(body);
}

async function poll(){
  try{await load();showError('');}catch(e){showError(e.message||'连接失败');}
}

form.addEventListener('submit',async(event)=>{
  event.preventDefault();
  const content=String(input.value||'').trim();
  if(!content||busy) return;
  busy=true;send.disabled=true;stop.hidden=false;newSession.disabled=true;input.value='';
  showError('');
  try{
    const response=await fetch('/api/chat-mobile/'+encodeURIComponent(token)+'/messages',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content})
    });
    const body=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(body.message||'发送失败');
    await load();
  }catch(e){
    busy=false;send.disabled=false;stop.hidden=true;newSession.disabled=false;
    showError(e.message||'发送失败');
  }
});

stop.addEventListener('click',async()=>{
  try{
    await fetch('/api/chat-mobile/'+encodeURIComponent(token)+'/cancel',{method:'POST'});
  }catch(_){}
  await poll();
});

newSession.addEventListener('click',async()=>{
  if(busy) return;
  if(!window.confirm('开启新对话？当前聊天会保留在电脑端历史中。')) return;
  newSession.disabled=true;
  showError('');
  try{
    const response=await fetch('/api/chat-mobile/'+encodeURIComponent(token)+'/new-session',{method:'POST'});
    const body=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(body.message||'创建失败');
    lastFingerprint='';
    await load();
  }catch(e){
    showError(e.message||'创建失败');
  }finally{
    newSession.disabled=false;
  }
});

uploadToggle.addEventListener('click',()=>{uploadPanel.hidden=!uploadPanel.hidden;if(!uploadPanel.hidden)uploadFile.focus();});
uploadClose.addEventListener('click',()=>{uploadPanel.hidden=true;});
uploadFile.addEventListener('change',()=>{
  selectedUpload=uploadFile.files&&uploadFile.files[0]||null;
  uploadSend.disabled=!selectedUpload;
  uploadSend.textContent='上传到电脑';
  uploadProgress.style.width='0';
  uploadStatus.className='uploadStatus';
  uploadStatus.textContent=selectedUpload?'文件已就绪':'等待选择文件';
  uploadName.textContent=selectedUpload?selectedUpload.name+' · '+Math.max(1,Math.ceil(selectedUpload.size/1024))+' KB':'支持任意文件，最大 20 MB';
});
uploadSend.addEventListener('click',()=>{
  if(!selectedUpload)return;
  if(selectedUpload.size>20971520){uploadStatus.className='uploadStatus bad';uploadStatus.textContent='文件超过 20 MB';return;}
  uploadSend.disabled=true;uploadProgress.style.width='12%';uploadStatus.className='uploadStatus';uploadStatus.textContent='正在读取文件…';
  const reader=new FileReader();
  reader.onerror=()=>uploadFailed('读取文件失败');
  reader.onprogress=(event)=>{if(event.lengthComputable)uploadProgress.style.width=(12+event.loaded/event.total*28)+'%';};
  reader.onload=async()=>{
    uploadProgress.style.width='48%';uploadStatus.textContent='正在传送到电脑…';
    try{
      const contentBase64=String(reader.result||'').split(',',2)[1]||'';
      const response=await fetch('/api/chat-mobile/'+encodeURIComponent(token)+'/upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:selectedUpload.name,contentBase64})});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(body.message||'上传失败');
      uploadProgress.style.width='100%';uploadStatus.className='uploadStatus ok';uploadStatus.textContent='已保存到 '+body.location;
      selectedUpload=null;uploadFile.value='';uploadSend.disabled=true;uploadSend.textContent='上传到电脑';uploadName.textContent='可继续选择其他文件';
    }catch(error){uploadFailed(error.message||'上传失败');}
  };
  reader.readAsDataURL(selectedUpload);
});
function uploadFailed(message){uploadSend.disabled=false;uploadProgress.style.width='0';uploadStatus.className='uploadStatus bad';uploadStatus.textContent=message;}

input.addEventListener('keydown',(event)=>{
  if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();form.requestSubmit();}
});

poll();
setInterval(poll,1200);
${mobileVoiceScript}
</script>
</body>
</html>`;
}

function expiredHtml() {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>链接已过期</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;color:#e8eefc;font:16px -apple-system,sans-serif}.card{max-width:420px;margin:24px;padding:28px;border:1px solid #243049;border-radius:20px;background:#121a2b}h1{margin:0 0 10px;font-size:20px}p{margin:0;color:#8b97b2;line-height:1.6}</style></head><body><section class="card"><h1>手机对话链接已过期</h1><p>请回到电脑上的 OpenClawX 对话页，重新打开二维码后再扫一次。</p></section></body></html>';
}

async function sessionBusy(sessionId: string) {
  const orch = getOrchestrator();
  const session = await orch.chat.getChatSession(sessionId);
  if (!session) return false;
  for (const message of session.messages.slice(-8)) {
    if (!message.runId || message.superseded) continue;
    const run = await orch.chat.getRun(message.runId);
    if (run && (run.status === 'running' || run.status === 'waiting-approval')) return true;
  }
  return false;
}

/** Authenticated: create a LAN QR link bound to an existing orch chat session. */
export const chatMobileRoutes: FastifyPluginAsync = async (app) => {
  app.post('/chat/mobile-session', async (request, reply) => {
    const auth = requireAuth(request);
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    const sessionId = String(body.sessionId || '').trim();
    if (!sessionId) return reply.code(400).send({ message: '缺少 sessionId。' });
    const orch = getOrchestrator();
    const session = await orch.chat.getChatSession(sessionId);
    if (!session || !canWriteOwnedResource(session, auth, { allowLegacyUnowned: true })) {
      return reply.code(404).send({ message: '对话不存在或无权访问。' });
    }
    const publicOrigin = mobilePublicOrigin(process.env.OPENCLAWX_MOBILE_PUBLIC_ORIGIN);
    const db = await database();
    const now = Date.now();
    const expiresAt = now + 8 * 60 * 60_000;
    db.run('DELETE FROM chat_mobile_links WHERE expires_at < ? OR session_id = ?', [now, sessionId]);
    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    db.run(
      'INSERT INTO chat_mobile_links (token, session_id, org_id, owner_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [token, sessionId, auth.orgId, auth.userId, now, expiresAt],
    );
    flushDatabase(db);
    const port = apiListenPort();
    const lanUrls = listLanIPv4Addresses().map((ip) => `http://${ip}:${port}/api/chat-mobile/${token}`);
    const managedTls = Boolean(process.env.OPENCLAWX_MOBILE_HTTPS_CA_FILE?.trim());
    const caUrl = managedTls && listLanIPv4Addresses()[0]
      ? `http://${listLanIPv4Addresses()[0]}:${port}/api/chat-mobile-ca`
      : undefined;
    return {
      token,
      expiresAt,
      sessionId,
      url: publicOrigin
        ? `${publicOrigin}/api/chat-mobile/${token}`
        : lanUrls[0] || `http://127.0.0.1:${port}/api/chat-mobile/${token}`,
      lanUrls,
      managedTls,
      caUrl,
    };
  });

  /** Desktop polls this while the QR sheet is open so phone “新对话” can switch the active session. */
  app.get('/chat/mobile-session/:token', async (request, reply) => {
    const auth = requireAuth(request);
    const { token } = request.params as { token: string };
    const link = await resolveLink(token);
    if (!link || link.ownerUserId !== auth.userId || link.orgId !== auth.orgId) {
      return reply.code(404).send({ message: '手机对话链接不存在或已过期。' });
    }
    const session = await getOrchestrator().chat.getChatSession(link.sessionId);
    return {
      token: link.token,
      sessionId: link.sessionId,
      expiresAt: link.expiresAt,
      title: session?.title || '对话',
    };
  });
};

/** Public token endpoints for phone browsers on the same LAN. */
export const publicChatMobileRoutes: FastifyPluginAsync = async (app) => {
  // A CA certificate contains no secret. HTTP bootstrap is intentional: the
  // phone cannot trust the HTTPS listener until this public certificate is installed.
  app.get('/chat-mobile-ca', async (_request, reply) => {
    const caFile = process.env.OPENCLAWX_MOBILE_HTTPS_CA_FILE?.trim();
    if (!caFile || !fs.existsSync(caFile)) return reply.code(404).send({ message: '本地手机证书不可用。' });
    return reply
      .header('cache-control', 'no-store')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .type('text/html; charset=utf-8')
      .send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>安装 OpenClawX 手机证书</title><style>body{margin:0;background:#f4f7fb;color:#182033;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.65}.card{max-width:520px;margin:36px auto;padding:26px;background:#fff;border:1px solid #dfe6f1;border-radius:20px;box-shadow:0 18px 50px #25385818}h1{font-size:22px;margin:0 0 8px}p{color:#596780}.notice{padding:12px 14px;background:#edf4ff;border-radius:12px;color:#31568e}.download{display:block;margin:20px 0;padding:13px;text-align:center;background:#4267e8;color:#fff;text-decoration:none;border-radius:12px;font-weight:700}ol{padding-left:22px}small{color:#7b879e}</style></head><body><main class="card"><h1>安装 OpenClawX 手机证书</h1><p class="notice">这是 OpenClawX 在当前电脑生成的本地 CA 公钥，不包含账号、密钥或聊天数据。</p><a class="download" href="/api/chat-mobile-ca/download">下载 CA 证书</a><ol><li>下载后打开手机“设置/安全/证书管理”。</li><li>选择安装 CA 证书，并选中刚下载的 <b>openclawx-mobile-ca.crt</b>。</li><li>按系统提示启用信任。仅点击浏览器的“继续访问”不等于信任证书。</li><li>回到电脑，切换回手机对话二维码并重新扫码。</li></ol><p><b>Android：</b>通常位于“设置 → 安全 → 更多安全设置 → 加密与凭据 → 安装证书 → CA 证书”。<br><b>iPhone：</b>安装描述文件后，还需进入“设置 → 通用 → 关于本机 → 证书信任设置”启用完全信任。</p><small>若地址栏仍显示红色证书标记，说明 CA 尚未成功安装或信任。</small></main></body></html>`);
  });
  app.get('/chat-mobile-ca/download', async (_request, reply) => {
    const caFile = process.env.OPENCLAWX_MOBILE_HTTPS_CA_FILE?.trim();
    if (!caFile || !fs.existsSync(caFile)) return reply.code(404).send({ message: '本地手机证书不可用。' });
    return reply.header('cache-control', 'no-store').header('content-disposition', 'attachment; filename="openclawx-mobile-ca.crt"').type('application/x-x509-ca-cert').send(fs.readFileSync(caFile));
  });

  // Capability URLs must never leak to external referrers or browser/shared caches.
  app.addHook('onSend', async (_request, reply) => { reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer'); });
  await registerMobileVoice(app, {
    resolve: resolveLink,
    authorized: async link => {
      const session = await getOrchestrator().chat.getChatSession(link.sessionId);
      return Boolean(session && canWriteOwnedResource(session, linkPrincipal(link), { allowLegacyUnowned: true }));
    },
    capabilities: () => {
      const settings = readRealtimeVoiceSettings();
      return { enabled: settings.enabled && Boolean(process.env.OPENCLAWX_VOLCENGINE_REALTIME_API_KEY?.trim() || settings.apiKey), workEnabled: settings.workLinkEnabled };
    },
    create: link => createBoundRealtimeVoice({ orgId: link.orgId, userId: link.ownerUserId }, link.sessionId),
    release: releaseBoundRealtimeVoice,
  });
  app.get('/chat-mobile/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const link = await resolveLink(token);
    if (!link) return reply.code(410).type('text/html; charset=utf-8').send(expiredHtml());
    return reply.type('text/html; charset=utf-8').send(mobileChatHtml(token));
  });

  app.get('/chat-mobile/:token/state', async (request, reply) => {
    const { token } = request.params as { token: string };
    const link = await resolveLink(token);
    if (!link) return reply.code(410).send({ message: '链接已过期，请在电脑上重新生成。' });
    const session = await getOrchestrator().chat.getChatSession(link.sessionId);
    if (!session || !canReadOwnedResource(session, linkPrincipal(link), { allowLegacyUnowned: true })) {
      return reply.code(404).send({ message: '对话不存在。' });
    }
    const payload = await publicMessagesLive(session);
    return { ...payload, busy: await sessionBusy(link.sessionId), expiresAt: link.expiresAt };
  });

  app.post('/chat-mobile/:token/new-session', async (request, reply) => {
    const { token } = request.params as { token: string };
    const link = await resolveLink(token);
    if (!link) return reply.code(410).send({ message: '链接已过期，请在电脑上重新生成。' });
    const orch = getOrchestrator();
    const current = await orch.chat.getChatSession(link.sessionId);
    if (!current || !canWriteOwnedResource(current, linkPrincipal(link), { allowLegacyUnowned: true })) {
      return reply.code(404).send({ message: '对话不存在。' });
    }
    await orch.chat.abortActiveRun(link.sessionId).catch(() => false);
    const created = await orch.chat.createChatSession({
      title: '新对话',
      employeeId: current.employeeId,
      orgId: link.orgId,
      ownerUserId: link.ownerUserId,
    });
    const db = await database();
    db.run('UPDATE chat_mobile_links SET session_id = ? WHERE token = ?', [created.id, link.token]);
    flushDatabase(db);
    return { sessionId: created.id, title: created.title, expiresAt: link.expiresAt };
  });

  app.post('/chat-mobile/:token/messages', async (request, reply) => {
    const { token } = request.params as { token: string };
    const link = await resolveLink(token);
    if (!link) return reply.code(410).send({ message: '链接已过期，请在电脑上重新生成。' });
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    const content = String(body.content || '').trim();
    if (!content) return reply.code(400).send({ message: '请输入内容。' });
    if (content.length > 8000) return reply.code(400).send({ message: '消息过长。' });
    const orch = getOrchestrator();
    const session = await orch.chat.getChatSession(link.sessionId);
    if (!session || !canWriteOwnedResource(session, linkPrincipal(link), { allowLegacyUnowned: true })) {
      return reply.code(404).send({ message: '对话不存在。' });
    }
    try {
      const result = await orch.chat.sendUserMessage(link.sessionId, { content });
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : '发送失败。' });
    }
  });

  app.post('/chat-mobile/:token/upload', { bodyLimit: 28 * 1024 * 1024 }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const link = await resolveLink(token);
    if (!link) return reply.code(410).send({ message: '链接已过期，请在电脑上重新生成。' });
    const session = await getOrchestrator().chat.getChatSession(link.sessionId);
    if (!session || !canWriteOwnedResource(session, linkPrincipal(link), { allowLegacyUnowned: true })) {
      return reply.code(404).send({ message: '对话不存在或无权上传。' });
    }
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    const contentBase64 = String(body.contentBase64 || '');
    if (!contentBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) return reply.code(400).send({ message: '文件内容无效。' });
    const bytes = Buffer.from(contentBase64, 'base64');
    if (!bytes.length) return reply.code(400).send({ message: '不能上传空文件。' });
    if (bytes.length > MOBILE_DESKTOP_UPLOAD_MAX_BYTES) return reply.code(413).send({ message: '文件超过 20 MB。' });
    try {
      const directory = desktopUploadDirectory();
      const target = uniqueUploadPath(directory, safeUploadName(body.name));
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      const folderLabel = path.basename(directory) === 'Documents' ? '文档' : '下载';
      return { ok: true, name: path.basename(target), sizeBytes: bytes.length, location: `${folderLabel}/${path.basename(target)}` };
    } catch (error) {
      return reply.code(500).send({ message: error instanceof Error ? error.message : '保存文件失败。' });
    }
  });

  app.post('/chat-mobile/:token/cancel', async (request, reply) => {
    const { token } = request.params as { token: string };
    const link = await resolveLink(token);
    if (!link) return reply.code(410).send({ message: '链接已过期。' });
    const orch = getOrchestrator();
    const session = await orch.chat.getChatSession(link.sessionId);
    if (!session || !canWriteOwnedResource(session, linkPrincipal(link), { allowLegacyUnowned: true })) {
      return reply.code(404).send({ message: '对话不存在。' });
    }
    const aborted = await orch.chat.abortActiveRun(link.sessionId);
    return { aborted };
  });

  // Optional SSE for future clients; phones currently poll /state for simplicity.
  app.get('/chat-mobile/:token/events', async (request, reply: FastifyReply) => {
    const { token } = request.params as { token: string };
    const link = await resolveLink(token);
    if (!link) return reply.code(410).send({ message: '链接已过期。' });
    const orch = getOrchestrator();
    const session = await orch.chat.getChatSession(link.sessionId);
    if (!session || !canReadOwnedResource(session, linkPrincipal(link), { allowLegacyUnowned: true })) {
      return reply.code(404).send({ message: '对话不存在。' });
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    const send = (event: OrcEvent) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`data: ${JSON.stringify({ ...event, ts: Date.now() })}\n\n`);
    };
    const unsubscribe = orch.subscribe(`session:${link.sessionId}`, send);
    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(': ping\n\n');
    }, 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
    };
    reply.raw.on('close', cleanup);
  });
};
