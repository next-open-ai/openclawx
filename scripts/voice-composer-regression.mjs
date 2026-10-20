import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const vueRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vue/package.json'));
const viteRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vite/package.json'));
const { parse, compileScript } = vueRequire('@vue/compiler-sfc');
const { build } = viteRequire('esbuild');
const Vue = vueRequire('vue');
const requests = [];
const mock = globalThis.__voiceComposerMock = { asr: null, realtime: null, notices: [] };
const result = await build({
  stdin: { contents: `export { default as CaptionStrip } from './apps/renderer/src/features/chat/VoiceCaptionStrip.vue'; export { default as Input } from './apps/renderer/src/features/chat/VoiceInputDialog.vue'; export { default as Realtime } from './apps/renderer/src/features/chat/RealtimeVoiceDialog.vue'; export * from './apps/renderer/src/features/chat/voice-presentation.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'voice-ui-test', setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: pathToFileURL(vueRequire.resolve('vue')).href, external: true }));
    builder.onResolve({ filter: /^@openclawx\/contracts$/ }, () => ({ path: pathToFileURL(path.resolve('packages/contracts/dist/index.js')).href, external: true }));
    builder.onResolve({ filter: /services\/realtime-voice$/ }, () => ({ path: 'voice-service', namespace: 'mock' }));
    builder.onResolve({ filter: /services\/voice-task-notices$/ }, () => ({ path: 'voice-notices', namespace: 'notice-mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ loader: 'js', contents: `
      const mock=globalThis.__voiceComposerMock;
      export const REALTIME_AUDIO_BATCH_BYTES=3200;
      export const REALTIME_AUDIO_PUMP_INTERVAL_MS=40;
      export const RealtimeVoiceUsageSchema={safeParse(value){return {success:true,data:value}}};
      export async function realtimeVoiceCapabilities(){return {voiceMode:'input',asr:{enabled:true},realtime:{enabled:true}};}
      export async function asrCommand(type,input){mock.request(type,input);return type==='session'?{session_id:'asr-test'}:{};}
      export async function createRealtimeVoiceSession(input){mock.request('realtime-session',input);return {sessionId:'realtime-test'};}
      export async function closeRealtimeVoiceSession(id){mock.request('realtime-close',id);}
      export async function sendRealtimeVoiceAudio(id,bytes){mock.request('realtime-audio',bytes.length);}
      export async function commitRealtimeVoiceAudio(id){mock.request('realtime-commit',id);}
      export async function interruptRealtimeVoice(id,responseEpoch,diagnostic){mock.request('realtime-interrupt',{id,responseEpoch,diagnostic});}
      export async function reportVoiceDiagnostic(id,diagnostic){mock.request('voice-diagnostic',{id,diagnostic});}
      export async function reportRealtimePlayback(id,responseEpoch,busy){mock.request('realtime-playback',{id,responseEpoch,busy});}
      export async function setRealtimeVoiceAudioMuted(id,muted){mock.request('realtime-mute',{id,muted});}
      export async function consumeAsrEvents(id,signal,handler){mock.asr=handler;handler({type:'connected'});await new Promise(r=>signal.addEventListener('abort',r,{once:true}));}
      export async function consumeRealtimeVoiceEvents(id,signal,handler){mock.realtime=handler;handler({type:'local.connected'});await new Promise(r=>signal.addEventListener('abort',r,{once:true}));}
    ` }));
    builder.onLoad({ filter: /.*/, namespace: 'notice-mock' }, () => ({ loader: 'js', contents: `const mock=globalThis.__voiceComposerMock;const claimed=new Set();export function claimVoiceTaskNotice(id,type){const key=id+':'+type;if(claimed.has(key))return false;claimed.add(key);return true}export class VoiceNoticePlayer{unlock(){} enqueue(value){mock.notices.push(value)} speak(text,value){mock.notices.push({text,value})} stop(){}}` }));
    builder.onLoad({ filter: /\.vue$/ }, args => {
      const { descriptor } = parse(fs.readFileSync(args.path, 'utf8'), { filename: args.path });
      const script = compileScript(descriptor, { id: args.path, inlineTemplate: true });
      return { contents: script.content, loader: 'ts', resolveDir: path.dirname(args.path) };
    });
  } }],
});
mock.request = (type, input) => requests.push({ type, input });
const ui = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

// VUI-R1/R2/R3: tested independently of a provider or real microphone.
const projection = new ui.VoiceDraftProjection(); projection.begin('已有草稿');
assert.equal(projection.update('已有草稿', '上海到桂'), '已有草稿\n上海到桂');
assert.equal(projection.update('已有草稿\n上海到桂', '上海到桂林'), '已有草稿\n上海到桂林');
assert.equal(projection.update('用户手动修改', '迟到结果'), '用户手动修改');
assert.deepEqual(ui.voiceEnvelope(new Float32Array(1024)), Array(28).fill(0));
assert.ok(ui.voiceEnvelope(new Float32Array(1024).fill(1)).every(v => v === 1));
assert.ok(ui.voiceEnvelope([NaN, Infinity]).every(Number.isFinite));
assert.equal(ui.hasRealtimeVoiceActivity(0.0001), false, 'idle microphone noise must not hold a turn open');
assert.equal(ui.hasRealtimeVoiceActivity(0.0029), false);
assert.equal(ui.hasRealtimeVoiceActivity(0.003), true, 'audible speech opens the realtime gate');
let rows = ui.mergeVoiceCaption([], { id: 'a', question: '你好', answer: '' });
rows = ui.mergeVoiceCaption(rows, { id: 'a', question: '你好啊', answer: '你好' });
assert.equal(rows.length, 1); assert.equal(rows[0].question, '你好啊');
for (let i = 0; i < 30; i++) rows = ui.mergeVoiceCaption(rows, { id: String(i), question: '下一轮', answer: '' });
assert.equal(rows.length, 20);

// VUI-R4: mount the real compiled Vue components with a memory renderer.
const makeNode = (type, text = '') => ({ type, text, children: [], props: {}, parent: null, value: '', tagName: type.toUpperCase(), addEventListener() {} });
globalThis.document = { activeElement: null };
const renderer = Vue.createRenderer({
  createElement: tag => makeNode(tag), createText: text => makeNode('text', text), createComment: text => makeNode('comment', text),
  setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
  patchProp: (node, key, _old, value) => { node.props[key] = value; },
  parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
  insert(node, parent, anchor) { if (node.parent) this.remove(node); const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, node); node.parent = parent; },
  remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; },
});
const find = (node, predicate) => predicate(node) ? node : node.children.map(child => find(child, predicate)).find(Boolean);
const flush = async () => { for (let i = 0; i < 8; i++) { await new Promise(r => setImmediate(r)); await Vue.nextTick(); } };
let processors = []; let tracks = [];
const sources = [];
globalThis.window = globalThis;
globalThis.requestAnimationFrame = callback => setTimeout(callback, 16);
globalThis.cancelAnimationFrame = clearTimeout;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { async getUserMedia() { const track = { stopped: false, enabled: true, getSettings(){return {echoCancellation:true};}, stop() { this.stopped = true; } }; tracks.push(track); return { getTracks: () => [track], getAudioTracks: () => [track] }; } } } });
globalThis.AudioContext = class {
  sampleRate = 48000; state = 'running'; currentTime = 0; destination = {};
  constructor(options){if(options?.sampleRate===24000&&mock.suspendPlayback)this.state='suspended';}
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() { const node = { connect() {}, disconnect() {}, onaudioprocess: null }; processors.push(node); return node; }
  createAnalyser() { return { fftSize: 1024, connect(){}, getFloatTimeDomainData(samples){samples.fill(.1);} }; }
  createBuffer(_channels, count, rate) { return { duration: count/rate, getChannelData(){return new Float32Array(count);} }; }
  createBufferSource() { const source={connect(){},disconnect(){},start(){},stop(){this.stopped=true;},stopped:false,onended:null};sources.push(source);return source; }
  async resume() { if(mock.suspendPlayback)await new Promise(resolve=>{mock.resumePlayback=resolve;}); }
  async close() { this.state = 'closed'; }
};
function mount(component, props) { const root = makeNode('root'); const app = renderer.createApp(component, props); app.mount(root); return { root, app }; }

const previews = []; const busy = []; let closed = 0;
const input = mount(ui.Input, { inline: true, autoStart: true, onPreview: value => previews.push(value), onBusy: value => busy.push(value), onClose: () => closed++ });
await flush();
assert.equal(find(input.root, node => node.props['aria-modal'] === 'true'), undefined, 'inline has no blocking dialog');
mock.asr({ type: 'transcript', text: '上海到桂', isFinal: false }); await flush();
mock.asr({ type: 'transcript', text: '上海到桂林', isFinal: false }); await flush();
assert.deepEqual(previews, ['上海到桂', '上海到桂林']); assert.equal(busy.at(-1), true);
processors.at(-1).onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(.1) } }); await flush();
assert.ok(find(input.root, n => n.type === 'span' && Number.parseFloat(n.props.style?.height) > 4), 'PCM samples drive the mounted bars');
find(input.root, n => n.props['aria-label'] === '暂停收音').props.onClick(); await flush();
assert.equal(tracks.at(-1).enabled, false);
find(input.root, n => n.type === 'button' && find(n, x => x.text === '结束录入')).props.onClick(); await flush();
assert.ok(requests.some(r => r.type === 'finish'));
mock.asr({ type: 'completed', text: '上海到桂林。' }); await flush();
assert.equal(previews.at(-1), '上海到桂林。'); assert.equal(busy.at(-1), false); assert.equal(tracks.at(-1).stopped, true);
find(input.root, n => n.props['aria-label'] === '关闭语音并保留已有内容').props.onClick(); await flush();
assert.equal(closed, 1); input.app.unmount();

// VUI-R6: execute the production submit/preview functions with isolated send stubs.
const chatSource = fs.readFileSync('apps/renderer/src/features/chat/ChatWorkspace.vue', 'utf8');
const submitSource = chatSource.slice(chatSource.indexOf('async function submit()'), chatSource.indexOf('function stopGeneration()'));
const previewSource = chatSource.slice(chatSource.indexOf('function previewVoiceText('), chatSource.indexOf('function updateVoiceCaption('));
assert.match(chatSource, /:disabled="!draft.trim\(\) \|\| !modelConfigured(?: \|\| resultQuestion\?\.loading)?"/);
assert.doesNotMatch(submitSource, /if \(voiceInputBusy.value\) return/);
const localRef = value => ({ value });
const sent = []; const sendErrors = []; const acceptedVoiceRuns = []; let rejectSend = false;
const draftProjection = new ui.VoiceDraftProjection(); draftProjection.begin('');
const env = {
  resultEvidence: localRef(null), resultQuestion: localRef(null),
  voiceCommandCandidate: { cancel() {}, update() {} }, canExecuteVoiceCommand: () => false, voiceTaskMonitor: { track: (...args) => acceptedVoiceRuns.push(args) }, voiceNoticePlayer: { enqueue() {} },
  voiceInputOpen: localRef(true), voiceInputBusy: localRef(true), draft: localRef(''), voiceProjection: draftProjection,
  files: localRef([]), images: localRef([]), recording: localRef(null), inputBusy: localRef(false), visionReady: localRef(true), visionHelp: localRef(''),
  autoSchedule: localRef(false), collaboratorIds: localRef([]), collaborationDelivery: localRef('direct'),
  mentionMenuOpen: localRef(false), collaboratorMenuOpen: localRef(false), sending: localRef(false), stickToBottom: localRef(false), onlineSearch: localRef(false),
  props: { modelConfigured: true, async sendMessage(text, ...args) { sent.push(text); if (rejectSend) throw new Error('mock send failure'); args[6]?.('server-session', 'server-run'); } },
  notify: { error: cause => sendErrors.push(cause) }, nextTick: callback => Promise.resolve().then(callback), scrollMessagesToBottom() {},
};
const productionFunctions = viteRequire('esbuild').transformSync(previewSource + submitSource, { loader: 'ts', target: 'es2022' }).code;
const handlers = new Function('env', `const {${Object.keys(env).join(',')}} = env; ${productionFunctions}; return {submit,previewVoiceText};`)(env);
await handlers.submit(); assert.equal(sent.length, 0); assert.equal(env.voiceInputOpen.value, true, 'empty submit keeps recording');
handlers.previewVoiceText('现在发送这段语音'); assert.equal(env.draft.value, '现在发送这段语音');
await handlers.submit(); assert.deepEqual(sent, ['现在发送这段语音']); assert.equal(env.voiceInputOpen.value, false); assert.equal(env.voiceInputBusy.value, false); assert.equal(env.draft.value, '');
assert.deepEqual(acceptedVoiceRuns, [['server-session', 'server-run']]);
handlers.previewVoiceText('迟到最终修订'); assert.equal(env.draft.value, ''); await handlers.submit(); assert.equal(sent.length, 1);
env.voiceInputOpen.value = true; env.voiceInputBusy.value = true; env.draft.value = '发送失败保留草稿'; rejectSend = true;
await handlers.submit(); handlers.previewVoiceText('迟到覆盖'); assert.equal(env.draft.value, '发送失败保留草稿'); assert.equal(env.voiceInputOpen.value, false); assert.equal(sendErrors.length, 1);
env.props.modelConfigured = false; env.voiceInputOpen.value = true; await handlers.submit(); assert.equal(sent.length, 2); assert.equal(env.voiceInputOpen.value, true);
env.props.modelConfigured = true; env.inputBusy.value = true; await handlers.submit(); assert.equal(sent.length, 2);

const cancelledPreviews = [];
const cancelledInput = mount(ui.Input, { inline: true, autoStart: true, onPreview: text => cancelledPreviews.push(text) });
await flush(); mock.asr({ type: 'transcript', text: '发送时文字', isFinal: false }); await flush();
const lateAsrEvent = mock.asr; const cancelledTrack = tracks.at(-1);
cancelledInput.app.unmount(); await flush();
const previewCount = cancelledPreviews.length;
lateAsrEvent({ type: 'transcript', text: '迟到结果', isFinal: true }); lateAsrEvent({ type: 'completed', text: '迟到最终结果' }); await flush();
assert.equal(cancelledPreviews.length, previewCount); assert.equal(cancelledTrack.stopped, true);
assert.ok(requests.some(request => request.type === 'close' && request.input.session_id === 'asr-test'));

const captions = [];
const realtime = mount(ui.Realtime, { inline: true, autoStart: true, conversationId: 'test-conversation', onCaptions: value => captions.push(value) });
await flush();
assert.ok(requests.some(r => r.type === 'realtime-session' && r.input.conversationId === 'test-conversation'));
mock.realtime({ type: 'local.work_notice', notice: { type: 'completed', taskId: '11111111-1111-4111-8111-111111111111', text: '任务舱回传：行程规划完成，1份成果已就位。你的判断很准！', delivery: 'provider' } }); await flush();
assert.deepEqual(mock.notices, [], 'provider-owned completion does not invoke browser or fixed local speech');
mock.realtime({ type: 'local.work_notice', notice: { type: 'completed', taskId: '22222222-2222-4222-8222-222222222222', text: '工作已完成。', delivery: 'fallback' } }); await flush();
mock.realtime({ type: 'local.work_notice', notice: { type: 'completed', taskId: '22222222-2222-4222-8222-222222222222', text: '工作已完成。', delivery: 'fallback' } }); await flush();
assert.deepEqual(mock.notices, ['completed'], 'fallback completion is fixed-audio only and deduplicated by task');
for (const event of [{ type: 'conversation.item.input_audio_transcription.started' }, { type: 'conversation.item.input_audio_transcription.completed', text: '帮我写报告' }, { type: 'response.output_text.delta', text: '工作已接受' }]) { mock.realtime({ type: 'upstream.event', event }); await flush(); }
assert.equal(captions.at(-1).question, '帮我写报告'); assert.equal(captions.at(-1).answer, '工作已接受');
assert.ok(find(realtime.root, n => n.props['aria-label'] === '语音字幕'), 'realtime captions render inside the dock');
assert.equal(find(realtime.root, n => n.type === 'textarea'), undefined, 'realtime never inserts a composer textarea');
// BI-A2: real component stops queued tail even after upstream generation ends.
const voiceEvent = (event, responseEpoch=1) => mock.realtime({type:'upstream.event',event,responseEpoch});
voiceEvent({type:'response.created',response:{id:'r1'}});
voiceEvent({type:'response.audio.delta',delta:Buffer.alloc(480).toString('base64')}); await flush();
voiceEvent({type:'response.done',response:{id:'r1'}}); await flush();
const interruptButton=find(realtime.root,n=>n.type==='button'&&n.text==='打断回答');
assert.ok(interruptButton,'queued playback remains interruptible after response.done');
interruptButton.props.onClick(); await flush();
assert.equal(sources.at(-1).stopped,true);
assert.equal(tracks.at(-1).stopped,false,'interrupt leaves mic alive');
assert.equal(requests.filter(r=>r.type==='realtime-interrupt').length,1);
const sourceCount=sources.length;
voiceEvent({type:'response.audio.delta',delta:Buffer.alloc(480).toString('base64')});
voiceEvent({type:'response.done'}); await flush(); assert.equal(sources.length,sourceCount);
voiceEvent({type:'conversation.item.input_audio_transcription.started'},2);
voiceEvent({type:'conversation.item.input_audio_transcription.completed',text:'换个问题'},2);
voiceEvent({type:'response.created',response:{id:'r2'}},3);
voiceEvent({type:'response.audio.delta',delta:Buffer.alloc(480).toString('base64')},3); await flush();
assert.equal(sources.length,sourceCount+1,'next response can play');
assert.ok(captions.some(c=>c.answer.includes('已打断')));
const processor=processors.at(-1);
for(let i=0;i<20;i++)processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(2048).fill(.3)}});
voiceEvent({type:'conversation.item.input_audio_transcription.delta',text:'停一下'},3);
await flush();assert.equal(requests.filter(r=>r.type==='realtime-interrupt').length,1,'local sound/text must never decide interruption');
mock.realtime({type:'local.provider_interrupted',responseEpoch:4});
await flush();assert.equal(sources.at(-1).stopped,true);
assert.equal(requests.filter(r=>r.type==='realtime-interrupt').length,1,'provider signal clears playback without cancelling');
voiceEvent({type:'conversation.item.input_audio_transcription.completed',text:'新问题'},4);
voiceEvent({type:'response.created',response:{id:'r3'}},5);
mock.suspendPlayback=true;
voiceEvent({type:'response.audio.delta',delta:Buffer.alloc(480).toString('base64')},5); await flush();
const beforeResume=sources.length;
find(realtime.root,n=>n.type==='button'&&n.text==='打断回答').props.onClick(); await flush();
mock.resumePlayback(); await flush();assert.equal(sources.length,beforeResume);
mock.suspendPlayback=false;
voiceEvent({type:'response.created',response:{id:'r4'}},7);
voiceEvent({type:'response.audio.delta',delta:Buffer.alloc(480).toString('base64')},7); await flush();
mock.realtime({type:'local.playback_stopped',responseEpoch:8});await flush();
assert.equal(sources.at(-1).stopped,true,'explicit bridge stops current audio');
assert.equal(find(realtime.root,n=>n.props['aria-label']==='允许开口打断'),undefined);
realtime.app.unmount(); await flush(); assert.equal(tracks.at(-1).stopped, true);

// Closing while browser permission is outstanding must not leak the late stream.
let permission;
navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { permission = resolve; });
const late = mount(ui.Realtime, { inline: true, autoStart: true }); await flush();
const beforePermissionSessions=requests.filter(r=>r.type==='realtime-session').length;
assert.equal(beforePermissionSessions,1,'pending mic permission must not create a provider session');
late.app.unmount(); const lateTrack = { stopped: false, stop() { this.stopped = true; } };
permission({ getTracks: () => [lateTrack] }); await flush(); assert.equal(lateTrack.stopped, true);
const classic = mount(ui.Input, {}); assert.ok(find(classic.root, n => n.props['aria-modal'] === 'true')); classic.app.unmount();
assert.equal(requests.filter(r => r.type === 'realtime-session').length, 1);

// VUI-R7: navigation retains the mounted audio component; manual close clears only local captions.
const appSource = fs.readFileSync('apps/renderer/src/app/App.vue', 'utf8');
assert.match(appSource, /<ChatWorkspace v-if="chatMounted" v-show="view === 'chat'"/);
assert.match(appSource, /if \(!user.value\) \{ chatMounted.value = false/);
assert.match(appSource, /@voice-active="voiceActive = \$event"/);
assert.match(chatSource, /@click="toggleVoice"/);
assert.doesNotMatch(chatSource, /:disabled="voiceOpening \|\| voiceInputOpen \|\| realtimeVoiceOpen" aria-label="开始/);
assert.doesNotMatch(chatSource, /voiceCaptions.length && !realtimeVoiceOpen/);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let capabilityRequest; let sessionRequest;
const voiceEnv = {
  voiceCommandCandidate: { cancel() {}, update() {} }, canExecuteVoiceCommand: () => false, voiceNoticePlayer: { unlock() {} },
  voiceOpening: localRef(false), voiceInputOpen: localRef(false), realtimeVoiceOpen: localRef(false), voiceInputBusy: localRef(false),
  voiceMode: localRef('input'), voiceConversationId: localRef(undefined), voiceCaptions: localRef([]), voiceProjection: new ui.VoiceDraftProjection(), draft: localRef('原草稿'),
  realtimeVoiceCapabilities: () => capabilityRequest ? capabilityRequest.promise : Promise.resolve({ voiceMode: 'realtime' }),
  props: { ensureServerSession: () => sessionRequest ? sessionRequest.promise : Promise.resolve('current-conversation') },
  refreshVoiceConversation: async () => {}, mergeVoiceCaption: ui.mergeVoiceCaption, notify: { error: error => { throw error; } },
  setInterval: () => 1, clearInterval() {},
};
const closeSource = chatSource.slice(chatSource.indexOf('async function closeRealtimeVoice()'), chatSource.indexOf('const activeVoiceWork'));
const toggleSource = chatSource.slice(chatSource.indexOf('async function toggleVoice()'), chatSource.indexOf('function previewVoiceText('));
const captionSource = chatSource.slice(chatSource.indexOf('function updateVoiceCaption('), chatSource.indexOf('watch(() => props.conversation?.id'));
const voiceFunctions = viteRequire('esbuild').transformSync('let voiceOpenGeneration = 0; let voiceRefreshTimer;\n' + closeSource + toggleSource + previewSource + captionSource, { loader: 'ts', target: 'es2022' }).code;
const voiceHandlers = new Function('env', `const {${Object.keys(voiceEnv).join(',')}} = env; ${voiceFunctions}; return {toggleVoice,updateVoiceCaption};`)(voiceEnv);
await voiceHandlers.toggleVoice(); assert.equal(voiceEnv.voiceInputOpen.value, true);
await voiceHandlers.toggleVoice(); assert.equal(voiceEnv.voiceInputOpen.value, false); assert.equal(voiceEnv.draft.value, '原草稿');
voiceEnv.voiceMode.value = 'realtime'; await voiceHandlers.toggleVoice(); assert.equal(voiceEnv.realtimeVoiceOpen.value, true);
voiceHandlers.updateVoiceCaption({ id: 'new', question: '你好', answer: '你好啊' }); assert.equal(voiceEnv.voiceCaptions.value.length, 1);
const persistedMessages = ['智能体工作与产物'];
voiceEnv.props.conversation = { serverSessionId: 'current-conversation', messages: persistedMessages };
await voiceHandlers.toggleVoice(); assert.equal(voiceEnv.realtimeVoiceOpen.value, false); assert.deepEqual(voiceEnv.voiceCaptions.value, []);
voiceHandlers.updateVoiceCaption({ id: 'late', question: '迟到字幕', answer: '' }); assert.deepEqual(voiceEnv.voiceCaptions.value, []); assert.deepEqual(persistedMessages, ['智能体工作与产物']);
capabilityRequest = deferred(); const opening = voiceHandlers.toggleVoice(); assert.equal(voiceEnv.voiceOpening.value, true);
await voiceHandlers.toggleVoice(); capabilityRequest.resolve({ voiceMode: 'realtime' }); await opening;
assert.equal(voiceEnv.voiceOpening.value, false); assert.equal(voiceEnv.realtimeVoiceOpen.value, false);
capabilityRequest = undefined; sessionRequest = deferred(); const creating = voiceHandlers.toggleVoice(); await flush();
await voiceHandlers.toggleVoice(); sessionRequest.resolve('late-conversation'); await creating; assert.equal(voiceEnv.realtimeVoiceOpen.value, false);

navigator.mediaDevices.getUserMedia = async () => { const track = { stopped: false, enabled: true, stop() { this.stopped = true; } }; tracks.push(track); return { getTracks: () => [track], getAudioTracks: () => [track] }; };
const navigation = Vue.ref('chat'); const ongoing = Vue.ref(true); const navCaptions = []; let navClosed = 0;
const beforeSessions = requests.filter(r => r.type === 'realtime-session').length;
const navigationApp = mount({ setup: () => () => Vue.h('section', { style: { display: navigation.value === 'chat' ? '' : 'none' } }, ongoing.value ? [Vue.h(ui.Realtime, { inline: true, autoStart: true, onCaptions: c => navCaptions.push(c), onClose: () => { navClosed++; ongoing.value = false; } })] : []) }, {});
await flush(); const navTrack = tracks.at(-1); const navEvents = mock.realtime;
navigation.value = 'settings'; await flush(); assert.equal(navTrack.stopped, false);
navEvents({ type: 'upstream.event', event: { type: 'conversation.item.input_audio_transcription.completed', text: '切页期间仍在通话' } }); await flush();
navigation.value = 'chat'; await flush();
assert.equal(requests.filter(r => r.type === 'realtime-session').length, beforeSessions + 1); assert.equal(navCaptions.at(-1).question, '切页期间仍在通话');
find(navigationApp.root, n => n.props['aria-label'] === '关闭语音并保留已有内容').props.onClick(); await flush();
assert.equal(navTrack.stopped, true); assert.equal(navClosed, 1); assert.equal(find(navigationApp.root, n => n.props['aria-label'] === '语音字幕'), undefined);
const navCount = navCaptions.length; navEvents({ type: 'upstream.event', event: { type: 'response.output_text.delta', text: '关闭后的迟到回复' } }); await flush(); assert.equal(navCaptions.length, navCount);
navigationApp.app.unmount(); await flush();
const asrNavigation = Vue.ref('chat'); const asrNavigationText = [];
const beforeAsrSessions = requests.filter(r => r.type === 'session').length;
const asrNavigationApp = mount({ setup: () => () => Vue.h('section', { style: { display: asrNavigation.value === 'chat' ? '' : 'none' } }, [Vue.h(ui.Input, { inline: true, autoStart: true, onPreview: text => asrNavigationText.push(text) })]) }, {});
await flush(); const asrNavigationTrack = tracks.at(-1);
asrNavigation.value = 'assets'; await flush(); assert.equal(asrNavigationTrack.stopped, false);
mock.asr({ type: 'transcript', text: '切页仍保留语音草稿', isFinal: false }); await flush();
asrNavigation.value = 'chat'; await flush(); assert.equal(asrNavigationText.at(-1), '切页仍保留语音草稿');
assert.equal(requests.filter(r => r.type === 'session').length, beforeAsrSessions + 1);
asrNavigationApp.app.unmount(); await flush(); assert.equal(asrNavigationTrack.stopped, true);
// VUI-R5: collapsed captions always show only the latest sentence; history is explicit.
const history = Vue.ref([]);
const strip = mount({ setup: () => () => Vue.h(ui.CaptionStrip, { captions: history.value }) }, {});
await flush(); assert.equal(find(strip.root, n => n.props['aria-label'] === '语音字幕'), undefined);
history.value = [{ id: 'one', question: '第一句', answer: '回复一' }, { id: 'two', question: '第二句', answer: '回复二' }];
await flush();
const preview = () => find(strip.root, n => n.props.class === 'voice-caption-preview').text;
const expand = () => find(strip.root, n => n.props['aria-controls']);
assert.equal(preview(), '回复二');
const captionComponentSource = fs.readFileSync('apps/renderer/src/features/chat/VoiceCaptionStrip.vue', 'utf8');
const controlSource = fs.readFileSync('apps/renderer/src/features/chat/VoiceControlBar.vue', 'utf8');
assert.match(captionComponentSource, /\.voice-captions\{width:100%;max-width:100%;min-width:0;overflow:hidden/);
assert.match(captionComponentSource, /\.voice-caption-preview\{display:block;flex:1 1 0;min-width:0;max-width:100%;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap/);
assert.match(controlSource, /\.voice-dock\{width:100%;max-width:100%;min-width:0;overflow:hidden/);
const realtimeSource = fs.readFileSync('apps/renderer/src/features/chat/RealtimeVoiceDialog.vue', 'utf8');
const noticeSource = fs.readFileSync('apps/renderer/src/services/voice-task-notices.ts', 'utf8');
assert.match(realtimeSource, /class="voice-inline-root"/);
assert.match(realtimeSource, /\.voice-inline-root\{box-sizing:border-box;width:100%;max-width:100%;min-width:0;overflow:hidden/);
assert.match(realtimeSource, /upstreamTurnOpen && !turnCommitSent && !turnCommitPending/);
assert.match(realtimeSource, /claimVoiceTaskNotice\(parsed\.data\.taskId/);
assert.doesNotMatch(realtimeSource, /speechSynthesis|SpeechSynthesisUtterance/);
assert.match(noticeSource, /utterance\.onstart = \(\) => \{ started = true/);
assert.match(noticeSource, /if \(!started\).*finish\(false\)/);
assert.match(noticeSource, /utterance\.onerror = \(\) => finish\(started\)/);
assert.match(chatSource, /relative grid min-w-0 gap-3/);
assert.match(chatSource, /notice === 'completed'.*voiceNoticePlayer\.speak\(VOICE_NOTICE_TEXT\.completed/s);
assert.equal(find(strip.root, n => n.props['aria-label'] === '上一条字幕'), undefined);
assert.equal(find(strip.root, n => n.props['aria-label'] === '下一条字幕'), undefined);
expand().props.onClick(); await flush(); assert.equal(expand().props['aria-expanded'], true);
assert.ok(find(strip.root, n => n.props['aria-label'] === '全部语音字幕'));
assert.ok(find(strip.root, n => n.type === 'p' && n.text === '第二句'));
history.value = [{ id: 'one', question: '第一句', answer: '回复一' }, { id: 'two', question: '第二句', answer: '回复二（修订）' }];
await flush(); assert.equal(preview(), '回复二（修订）');
expand().props.onClick(); await flush();
strip.app.unmount();
const reduced = mount(ui.CaptionStrip, { captions: Array.from({ length: 20 }, (_, i) => ({ id: String(i), question: `问题${i}`, answer: `回复${i}` })) });
await flush(); assert.equal(find(reduced.root, n => n.props.class === 'voice-caption-preview').text, '回复19');
find(reduced.root, n => n.props['aria-controls']).props.onClick(); await flush();
assert.ok(find(reduced.root, n => n.type === 'p' && n.text === '问题0'), 'expanded history includes every retained turn');
reduced.app.unmount();
console.log('VUI-R1–R7 PASS: draft, latest-caption preview, expanded history, PCM, lifecycle, ASR send, navigation retention, microphone toggle, connection cancellation and caption cleanup.');
console.log('BI-A2/A6 PASS: provider-owned interruption, no local sound/text cancellation, bridge stop and resume race.');
