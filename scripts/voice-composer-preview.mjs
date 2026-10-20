// Isolated visual fixture: synthetic PCM and events, no credentials or API calls.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
const vueRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vue/package.json'));
const viteRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vite/package.json'));
const { parse, compileScript } = vueRequire('@vue/compiler-sfc');
const { build } = viteRequire('esbuild');
const styles = [];
const bundle = await build({ bundle: true, write: false, platform: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"development"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  stdin: { loader: 'js', resolveDir: process.cwd(), contents: String.raw`
    import {createApp,ref} from 'vue';
    import Input from './apps/renderer/src/features/chat/VoiceInputDialog.vue';
    import Realtime from './apps/renderer/src/features/chat/RealtimeVoiceDialog.vue';
    import {VoiceDraftProjection} from './apps/renderer/src/features/chat/voice-presentation.ts';
    class AudioMock{sampleRate=48000;state='running';destination={};timers=[];createMediaStreamSource(){return {connect(){},disconnect(){}}}createScriptProcessor(){const node={disconnect(){},connect(){},onaudioprocess:null};this.timers.push(setInterval(()=>node.onaudioprocess?.({inputBuffer:{getChannelData:()=>Float32Array.from({length:4096},(_,i)=>Math.sin(i*.18)*(.06+.04*Math.sin(Date.now()/300)))}}),70));return node;}async close(){this.timers.forEach(clearInterval);this.state='closed';}async resume(){}}
    window.AudioContext=AudioMock;
    Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{const track={enabled:true,stop(){}};return {getTracks:()=>[track],getAudioTracks:()=>[track]};}}});
    createApp({components:{Input,Realtime},setup(){const mode=ref('input'),open=ref(true),draft=ref('请调整这份旅游行程：'),question=ref(''),answer=ref(''),busy=ref(false);const projection=new VoiceDraftProjection();projection.begin(draft.value);return {mode,open,draft,question,answer,busy,begin:()=>projection.begin(draft.value),preview:t=>draft.value=projection.update(draft.value,t),captions:c=>{question.value=c.question;answer.value=c.answer;}};},template:
    '<main class="max-w-3xl mx-auto p-6"><div class="rounded-3xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden shadow-xl"><header class="p-5 border-b border-[var(--border)]"><strong>上海 → 桂林 · 旅行规划</strong><p class="text-xs mt-1 text-[var(--muted)]">通用助手 · 组件验收 / 模拟音频</p></header><div class="p-6 space-y-5 min-h-[200px]"><p class="ml-auto w-fit rounded-2xl bg-[var(--accent-soft)] p-3 text-sm">把六天的行程安排得轻松一点。</p><div class="text-sm leading-7">行程已整理好。你可以直接说出想调整的地方。<div class="mt-3 rounded-xl border border-[var(--border)] p-3 text-xs">上海到桂林6天旅游行程.md · 当前对话成果</div></div></div><div class="p-5 pt-0"><div class="rounded-2xl border border-[var(--border)] p-3 space-y-3"><Input v-if="open&&mode===\'input\'" inline auto-start @session-start="begin" @preview="preview" @busy="busy=$event" @close="open=false"/><Realtime v-if="open&&mode===\'realtime\'" inline auto-start @captions="captions" @close="open=false"/><textarea v-model="draft" :readonly="busy" aria-label="对话输入框" class="w-full bg-transparent border-0 text-sm min-h-20 p-1"></textarea><footer class="border-t border-[var(--border)] pt-3 flex flex-wrap gap-2"><select v-model="mode" aria-label="语音模式" @change="open=true" class="rounded-lg p-2 text-xs bg-[var(--surface-muted)]"><option value="input">语音输入 · 手动发送</option><option value="realtime">实时对话 · 自动回复</option></select><button type="button" @click="open=!open" class="rounded-lg border border-[var(--border)] p-2 text-xs">{{open?\'收起语音\':\'开启语音\'}}</button><button type="button" :disabled="busy" class="ml-auto rounded-lg bg-[var(--accent)] text-white px-4 disabled:opacity-30">↑</button></footer></div></div></div><p class="mt-4 text-xs text-[var(--muted)]">此页仅使用模拟音频和事件，不连接火山、不录音、不执行 Agent。</p></main>'}).mount('#app');
  ` }, plugins: [{ name: 'voice-fixture', setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: vueRequire.resolve('vue/dist/vue.esm-bundler.js') }));
    builder.onResolve({ filter: /^@openclawx\/contracts$/ }, () => ({ path: path.resolve('packages/contracts/dist/index.js') }));
    builder.onResolve({ filter: /services\/realtime-voice$/ }, () => ({ path: 'service', namespace: 'mock' }));
    builder.onResolve({ filter: /services\/voice-task-notices$/ }, () => ({ path: 'notices', namespace: 'notice-mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ loader: 'js', contents: `let asr;export async function realtimeVoiceCapabilities(){return {asr:{enabled:true},realtime:{enabled:true}}}export async function asrCommand(type){if(type==='finish')asr?.({type:'completed',text:'把第三天的漓江行程改成轻松一点的安排。'});return {session_id:'synthetic'}}export async function consumeAsrEvents(id,signal,handler){asr=handler;handler({type:'connected'});const timer=setTimeout(()=>handler({type:'transcript',text:'把第三天的漓江行程改成轻松一点的安排。',isFinal:false}),800);signal.addEventListener('abort',()=>clearTimeout(timer));return new Promise(r=>signal.addEventListener('abort',r,{once:true}));}export async function createRealtimeVoiceSession(){return {sessionId:'synthetic'}}export async function closeRealtimeVoiceSession(){}export async function sendRealtimeVoiceAudio(){}export async function commitRealtimeVoiceAudio(){}export async function setRealtimeVoiceAudioMuted(){}export async function consumeRealtimeVoiceEvents(id,signal,handler){handler({type:'local.connected'});const timer=setTimeout(()=>{for(const event of [{type:'conversation.item.input_audio_transcription.started'},{type:'conversation.item.input_audio_transcription.completed',text:'这是一个用于验证输入区宽度边界的超长连续实时转写内容。'.repeat(18)},{type:'response.output_text.done',text:'这是模型回复的超长连续字幕，用来确认回复同样不会向右撑开输入区。'.repeat(18)},{type:'response.done'}])handler({type:'upstream.event',event});},500);signal.addEventListener('abort',()=>clearTimeout(timer));return new Promise(r=>signal.addEventListener('abort',r,{once:true}));}` }));
    builder.onLoad({ filter: /.*/, namespace: 'notice-mock' }, () => ({ loader: 'js', contents: `export class VoiceNoticePlayer{unlock(){}speak(){}stop(){}}` }));
    builder.onLoad({ filter: /\.vue$/ }, args => { const { descriptor } = parse(fs.readFileSync(args.path, 'utf8'), { filename: args.path }); styles.push(...descriptor.styles.map(style => style.content));return { contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content, loader: 'ts', resolveDir: path.dirname(args.path) }; });
  } }],
});
const cssDir = 'apps/renderer/dist/assets';
const cssFile = fs.readdirSync(cssDir).find(name => name.endsWith('.css') && name.startsWith('index-'));
const css = fs.readFileSync(path.join(cssDir, cssFile), 'utf8') + styles.join('\n');
const server = createServer((request, reply) => {
  if (request.url === '/bundle.js') { reply.setHeader('content-type', 'text/javascript'); reply.end(bundle.outputFiles[0].text); }
  else if (request.url === '/style.css') { reply.setHeader('content-type', 'text/css'); reply.end(css); }
  else { reply.setHeader('content-type', 'text/html'); reply.end('<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenClawX 语音组件验收</title><link rel="stylesheet" href="/style.css"><body><div id="app"></div><script type="module" src="/bundle.js"></script></body></html>'); }
});
server.listen(47843, '127.0.0.1', () => console.log('Isolated synthetic voice fixture: http://127.0.0.1:47843'));
process.on('SIGINT', () => server.close(() => process.exit(0)));
