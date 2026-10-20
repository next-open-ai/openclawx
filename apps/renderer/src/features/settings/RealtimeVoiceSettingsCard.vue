<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import RealtimeVoiceDialog from '../chat/RealtimeVoiceDialog.vue';
import VoiceInputDialog from '../chat/VoiceInputDialog.vue';
import { getRealtimeVoiceSettings, queryRealtimeVoiceClone, saveRealtimeVoiceSettings, trainRealtimeVoiceClone, type RealtimeVoiceSettings } from '../../services/realtime-voice';

const props = withDefaults(defineProps<{ isAdmin?: boolean; ensureVoiceConversation?: () => Promise<string | null>; testRequest?: number }>(), { isAdmin: false, testRequest: 0 });
const voiceConversationId = ref<string>();
const crypto = window.crypto;
const emit = defineEmits<{ 'open-work': [conversationId: string, title: string]; 'configure-model': [] }>();
const loading = ref(true); const saving = ref(false); const testing = ref(false); const cloneBusy = ref(false);
const message = ref(''); const error = ref(''); const apiKey = ref('');
const asrApiKey = ref(''); const clearAsrApiKey = ref(false);
const cloneVoiceId = ref(''); const cloneFile = ref<File | null>(null); const cloneText = ref(''); const cloneDemoText = ref('');
const cloneDenoise = ref(false); const cloneKeepVolume = ref(false);
const builtInVoices = [
  { id: 'zh_female_vv_jupiter_bigtts', name: 'VV 女声', detail: '自然、亲和，适合通用助手' },
  { id: 'zh_female_xiaohe_jupiter_bigtts', name: '小荷女声', detail: '清晰、年轻，适合服务场景' },
  { id: 'zh_male_yunzhou_jupiter_bigtts', name: '云舟男声', detail: '沉稳、自然，适合专业场景' },
  { id: 'zh_male_xiaotian_jupiter_bigtts', name: '小天男声', detail: '明快、有活力' },
  { id: 'saturn_zh_female_aojiaonvyou_tob', name: '傲娇女友', detail: '精品克隆音色，不支持唱歌' },
];
const settings = ref<RealtimeVoiceSettings>({ voiceMode: 'realtime', asrEnabled: true, asrReuseKey: true, asrResourceId: 'volc.seedasr.sauc.duration', asrEnablePunc: true, asrEnableItn: true, asrConfigured: false, asrApiKeyMasked: '', asrKeySource: 'realtime', enabled: true, workLinkEnabled: false, audioGateEnabled: false, configured: false, apiKeyMasked: '', apiKeySource: 'settings', model: '1.2.6.1', voice: builtInVoices[0].id, instructions: '你是 OpenClawX 的实时语音助手。使用简洁自然的中文交流，不要声称执行了尚未执行的业务操作。', enableProactiveSpeak: false, dialogId: '', speed: 0, loudness: 0, enableMusic: true, clonedVoices: [] });
const selectedVoiceName = computed(() => builtInVoices.find((item) => item.id === settings.value.voice)?.name || settings.value.voice || '未选择');
const modeKeyConfigured = computed(() => settings.value.voiceMode === 'realtime' || settings.value.asrReuseKey ? settings.value.configured : settings.value.asrKeySource !== 'realtime' && settings.value.asrConfigured);

async function openRealtimeTest() {
  if (!settings.value.configured) { error.value = '请先在 Provider 与模型中配置实时语音模型。'; return; }
  if (props.ensureVoiceConversation) {
    const id = await props.ensureVoiceConversation();
    if (!id) throw new Error('无法关联当前对话，请创建对话后重试。');
    voiceConversationId.value = id;
  }
  testing.value = true;
}
async function load() { loading.value = true; error.value = ''; try { settings.value = await getRealtimeVoiceSettings(); if (props.testRequest > 0) await openRealtimeTest(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { loading.value = false; } }
function payload() { return { voiceMode: settings.value.voiceMode, asrEnabled: settings.value.asrEnabled, asrReuseKey: settings.value.asrReuseKey, asrResourceId: settings.value.asrResourceId, asrEnablePunc: settings.value.asrEnablePunc, asrEnableItn: settings.value.asrEnableItn, ...(asrApiKey.value.trim() ? { asrApiKey: asrApiKey.value.trim() } : {}), clearAsrApiKey: clearAsrApiKey.value, enabled: settings.value.enabled, workLinkEnabled: settings.value.workLinkEnabled, audioGateEnabled: settings.value.audioGateEnabled, ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}), model: settings.value.model, voice: settings.value.voice, instructions: settings.value.instructions, enableProactiveSpeak: settings.value.enableProactiveSpeak, dialogId: settings.value.dialogId, speed: settings.value.speed, loudness: settings.value.loudness, enableMusic: settings.value.enableMusic, clonedVoices: settings.value.clonedVoices }; }
async function save(openTest = false) {
  if (!props.isAdmin) return;
  saving.value = true; message.value = ''; error.value = '';
  try {
    settings.value = await saveRealtimeVoiceSettings(payload());
    apiKey.value = ''; asrApiKey.value = ''; clearAsrApiKey.value = false;
    message.value = settings.value.voiceMode === 'input' ? '语音输入配置已保存。' : '实时通话偏好已保存；连接、模型和音色由 Provider 与模型统一管理。';
    if (openTest) {
      if (settings.value.voiceMode === 'realtime') await openRealtimeTest(); else testing.value = true;
    }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { saving.value = false; }
}
function chooseFile(event: Event) { cloneFile.value = (event.target as HTMLInputElement).files?.[0] || null; }
function fileBase64(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '').split(',').pop() || ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); }
function mergeClone(voice: RealtimeVoiceSettings['clonedVoices'][number], select = false) { settings.value.clonedVoices = [voice, ...settings.value.clonedVoices.filter((item) => item.id !== voice.id)]; if (select) settings.value.voice = voice.id; }
async function trainClone() { if (!cloneFile.value) { error.value = '请先选择训练音频。'; return; } cloneBusy.value = true; error.value = ''; try { const ext = cloneFile.value.name.toLowerCase().split('.').pop() || ''; const voice = await trainRealtimeVoiceClone({ voiceId: cloneVoiceId.value.trim(), audio: { format: ext, data: await fileBase64(cloneFile.value) }, text: cloneText.value.trim(), demoText: cloneDemoText.value.trim(), enableAudioDenoise: cloneDenoise.value, keepOriginalVolume: cloneKeepVolume.value }); mergeClone(voice, true); await save(false); message.value = `音色 ${voice.id} 已提交训练，当前状态：${voice.statusName}`; } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { cloneBusy.value = false; } }
async function queryClone(id = cloneVoiceId.value.trim()) { cloneBusy.value = true; error.value = ''; try { const voice = await queryRealtimeVoiceClone(id); mergeClone(voice); cloneVoiceId.value = id; message.value = `${id}：${voice.statusName}`; } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } finally { cloneBusy.value = false; } }
function importClone() { const id = cloneVoiceId.value.trim(); if (!id || /\s/.test(id)) { error.value = '请填写有效的音色槽位 ID。'; return; } mergeClone({ id, status: null, statusName: '已保存', updatedAt: Date.now() }, true); message.value = `已添加已有音色 ${id}，保存配置后生效。`; }
onMounted(load);
watch(() => props.testRequest, (next, previous) => { if (next > previous && !loading.value) void openRealtimeTest().catch((cause) => { error.value = cause instanceof Error ? cause.message : String(cause); }); });
</script>

<template>
  <section class="overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)]">
    <header class="bg-[radial-gradient(circle_at_top_right,var(--accent-soft),transparent_55%)] p-6 sm:p-8"><div class="flex flex-wrap items-start justify-between gap-4"><div><p class="text-[11px] font-extrabold tracking-[.14em] text-[var(--accent)]">OPENCLAWX · VOICE SERVICES</p><h2 class="mt-2 text-2xl font-bold">语音体验</h2><p class="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted)]">连接密钥、实时模型和音色已统一归入「Provider 与模型」；这里只设置通话行为并进行体验测试。</p></div><span :class="['rounded-full px-3 py-1.5 text-xs font-bold', modeKeyConfigured ? 'bg-emerald-500/12 text-emerald-700' : 'bg-amber-500/12 text-amber-700']">{{ modeKeyConfigured ? '模型已就绪 · 请测试权限' : '请先配置实时语音模型' }}</span></div></header>
    <div v-if="loading" class="p-8 text-sm text-[var(--muted)]">正在读取语音配置…</div>
    <div v-else class="space-y-6 p-5 sm:p-8">
      <section class="box">
        <h3 class="font-bold">语音能力入口</h3><p class="hint">两条链路独立配置、独立保存；其中一项不可用不会影响另一项或文字聊天。</p>
        <div class="mt-4 grid gap-3 sm:grid-cols-2" role="tablist" aria-label="语音能力">
          <button type="button" role="tab" :aria-selected="settings.voiceMode === 'realtime'" :class="['voice-capability', settings.voiceMode === 'realtime' && 'voice-capability-active']" @click="settings.voiceMode = 'realtime'"><span><strong>实时对话</strong><small>端到端听、想、说</small></span><em :class="settings.configured && settings.enabled ? 'ready' : ''">{{ settings.configured && settings.enabled ? '可用' : '待配置' }}</em></button>
          <button type="button" role="tab" :aria-selected="settings.voiceMode === 'input'" :class="['voice-capability', settings.voiceMode === 'input' && 'voice-capability-active']" @click="settings.voiceMode = 'input'"><span><strong>语音输入</strong><small>ASR 转文字，确认后发送</small></span><em :class="settings.asrConfigured && settings.asrEnabled ? 'ready' : ''">{{ settings.asrConfigured && settings.asrEnabled ? '可用' : '待配置' }}</em></button>
        </div>
        <p class="hint mt-3">实时通话字幕使用现有转写事件，不额外调用 ASR。语音输入不播音、不启动 Agent、不自动发送。</p>
      </section>
      <section v-if="settings.voiceMode === 'input'" class="box space-y-4">
        <label class="check"><input v-model="settings.asrEnabled" type="checkbox" :disabled="!isAdmin" />启用语音输入</label>
        <label class="check"><input v-model="settings.asrReuseKey" type="checkbox" :disabled="!isAdmin" />复用实时语音 API Key</label>
        <label v-if="settings.asrReuseKey" class="block"><span class="label">共用语音 API Key</span><input v-model="apiKey" type="password" autocomplete="new-password" class="field w-full" :disabled="!isAdmin" :placeholder="settings.configured ? `${settings.apiKeyMasked}（留空保持不变）` : '填写豆包语音 API Key'" /></label>
        <div v-else class="space-y-3"><label class="block"><span class="label">独立 ASR API Key</span><input v-model="asrApiKey" type="password" autocomplete="new-password" class="field w-full" :disabled="!isAdmin || clearAsrApiKey" :placeholder="settings.asrKeySource !== 'realtime' && settings.asrConfigured ? `${settings.asrApiKeyMasked}（留空保持不变）` : '填写独立 ASR API Key'" /></label><label class="check"><input v-model="clearAsrApiKey" type="checkbox" :disabled="!isAdmin" />清除已保存的独立 ASR 密钥（不影响共用密钥）</label></div>
        <p class="hint">密钥仅服务端保存。密钥已配置不代表 ASR 权限已开通；请在火山控制台开通对应模型与计费资源。独立环境变量密钥优先于保存值。</p>
        <label class="block"><span class="label">识别模型 / 计费资源</span><select v-model="settings.asrResourceId" class="field w-full" :disabled="!isAdmin"><option value="volc.seedasr.sauc.duration">SeedASR 2.0 · 按时长（推荐）</option><option value="volc.seedasr.sauc.concurrent">SeedASR 2.0 · 并发资源</option><option value="volc.bigasr.sauc.duration">BigASR 1.0 · 按时长</option><option value="volc.bigasr.sauc.concurrent">BigASR 1.0 · 并发资源</option></select></label>
        <div class="flex flex-wrap gap-4"><label class="check"><input v-model="settings.asrEnablePunc" type="checkbox" :disabled="!isAdmin" />自动标点</label><label class="check"><input v-model="settings.asrEnableItn" type="checkbox" :disabled="!isAdmin" />数字与日期规范化</label></div>
        <p class="hint">PCM 16 kHz · 流式识别 + 分句二遍修订 · 最多 2 分钟 · 不保存录音</p>
      </section>
      <div v-show="settings.voiceMode === 'realtime'" class="space-y-6">
      <section class="box">
        <label class="flex items-center justify-between gap-4"><span><strong>关联 OpenClawX 工作能力</strong><small class="hint">语音启动、查询和取消员工任务；员工使用已授权的 Skill 和 MCP。</small></span><input v-model="settings.workLinkEnabled" type="checkbox" :disabled="!isAdmin" class="h-5 w-5 accent-[var(--accent)]" /></label>
        <p class="hint mt-3">语音工作默认进入当前对话，消息、成果和审批直接显示在该对话中；配置测试也关联当前对话，通过卡片进入查看。关闭后为纯语音对话，已启动任务继续运行。保存后新通话生效。</p>
      </section>
      <section class="box"><div class="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h3 class="font-bold">实时语音模型</h3><p class="hint">连接、凭证、模型与音色统一由 Provider 与模型管理</p></div><div class="flex items-center gap-3"><button class="secondary text-[var(--accent)]" type="button" @click="emit('configure-model')">配置实时语音模型</button><input v-model="settings.enabled" type="checkbox" class="h-5 w-5 accent-[var(--accent)]" :disabled="!isAdmin" /></div></div><div class="grid gap-3 rounded-xl bg-[var(--surface-muted)] p-4 text-sm sm:grid-cols-3"><div><span class="hint">Provider</span><strong>{{ settings.providerName || '尚未绑定' }}</strong></div><div><span class="hint">实时模型</span><strong>{{ settings.model || '—' }}</strong></div><div><span class="hint">音色</span><strong>{{ selectedVoiceName }}</strong></div></div><p class="hint mt-3">点击“配置实时语音模型”可直接选择常用音色或填写克隆音色 ID。旧版独立语音配置仅在尚未绑定实时模型时兼容回退。</p><label class="mt-4 block"><span class="mb-2 flex items-center justify-between text-sm font-semibold">Dialog ID <button class="text-xs text-[var(--accent)]" type="button" @click="settings.dialogId = crypto.randomUUID()">生成 UUID</button></span><input v-model="settings.dialogId" class="field w-full" placeholder="留空创建新上下文" :disabled="!isAdmin" /></label><p class="hint mt-3">实时音频采用稳定低延迟传输，由服务端统一判停，避免断句、重复提交和回复延迟。</p></section>
      <section class="box"><div class="mb-5"><h3 class="font-bold">声音表现</h3><p class="hint">音色跟随当前实时语音模型；这里只调整播放表现</p></div><div class="mt-5 grid gap-5 sm:grid-cols-2"><label><span class="range-label">语速 speed <button type="button" @click="settings.speed = 0">归零</button></span><div class="flex items-center gap-3"><input v-model.number="settings.speed" type="range" min="-50" max="100" class="w-full accent-[var(--accent)]" /><output class="range-value">{{ settings.speed }}</output></div></label><label><span class="range-label">音量 loudness <button type="button" @click="settings.loudness = 0">归零</button></span><div class="flex items-center gap-3"><input v-model.number="settings.loudness" type="range" min="-50" max="100" class="w-full accent-[var(--accent)]" /><output class="range-value">{{ settings.loudness }}</output></div></label></div></section>
      <details class="rounded-2xl border border-[var(--border)]" open><summary class="cursor-pointer list-none p-5"><div class="flex justify-between"><span><strong class="block">声音复刻</strong><small class="hint">训练新音色或接入已有预付费音色槽位</small></span><span class="text-xs text-[var(--muted)]">{{ settings.clonedVoices.length }} 个音色</span></div></summary><div class="space-y-4 border-t border-[var(--border)] p-5"><div class="grid gap-4 sm:grid-cols-2"><label><span class="label">预付费音色槽位 ID</span><input v-model="cloneVoiceId" class="field w-full" placeholder="例如 S_..." /></label><label><span class="label">训练音频</span><input type="file" accept=".wav,.mp3,.ogg,.m4a,.aac,.pcm,audio/*" class="field w-full" @change="chooseFile" /></label><label class="sm:col-span-2"><span class="label">朗读文本</span><textarea v-model="cloneText" rows="2" class="field w-full" placeholder="可选：训练音频对应文本" /></label><label class="sm:col-span-2"><span class="label">试听文本</span><input v-model="cloneDemoText" maxlength="300" class="field w-full" placeholder="可选，4 到 300 字" /></label></div><div class="flex flex-wrap items-center gap-4"><button class="primary" type="button" :disabled="cloneBusy || !isAdmin" @click="trainClone">{{ cloneBusy ? '处理中…' : '开始训练' }}</button><button class="secondary" type="button" :disabled="cloneBusy || !isAdmin" @click="importClone">保存已有音色</button><button class="secondary" type="button" :disabled="cloneBusy || !isAdmin" @click="queryClone()">查询状态</button><label class="check"><input v-model="cloneDenoise" type="checkbox" />音频降噪</label><label class="check"><input v-model="cloneKeepVolume" type="checkbox" />保留原始音量</label></div><button v-for="voice in settings.clonedVoices" :key="voice.id" type="button" class="flex w-full justify-between rounded-xl bg-[var(--surface-muted)] px-4 py-3 text-left text-sm" @click="settings.voice = voice.id"><span><strong>{{ voice.id }}</strong><small class="ml-2 text-[var(--muted)]">{{ voice.statusName }}</small></span><span class="text-xs text-[var(--accent)]" @click.stop="queryClone(voice.id)">刷新状态</span></button></div></details>
      <section class="box"><h3 class="font-bold">对话策略</h3><p class="hint">System Prompt 与模型行为开关</p><textarea v-model="settings.instructions" rows="10" class="field mt-4 w-full font-mono text-xs leading-5" :disabled="!isAdmin" /><div class="mt-4 flex flex-wrap gap-5"><label class="check"><input v-model="settings.enableProactiveSpeak" type="checkbox" />主动回复</label><label class="check"><input v-model="settings.enableMusic" type="checkbox" />允许唱歌</label><span class="rounded-full bg-[var(--surface-muted)] px-3 py-1 text-xs text-[var(--muted)]">Function Calling 由 OpenClawX Skill / MCP 权限中心统一管理</span></div></section>
      </div>
      <p v-if="message" class="rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700">{{ message }}</p><p v-if="error" class="rounded-xl bg-rose-500/10 px-4 py-3 text-sm text-rose-700">{{ error }}</p><p v-if="!isAdmin" class="text-xs text-[var(--muted)]">只有管理员可以修改和训练语音配置。</p>
      <div class="sticky bottom-4 flex justify-end gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)]/95 p-4 shadow-xl backdrop-blur"><button class="secondary" type="button" :disabled="saving || !isAdmin" @click="save(false)">保存配置</button><button class="primary" type="button" :disabled="saving || !isAdmin" @click="save(true)">{{ saving ? '正在保存…' : settings.voiceMode === 'input' ? '保存并测试语音输入' : '保存并进入通话测试' }}</button></div>
    </div>
  </section>
  <RealtimeVoiceDialog v-if="testing && settings.voiceMode === 'realtime'" :conversation-id="voiceConversationId" title="SeedDuplex 配置测试" subtitle="OpenClawX 直连火山 · 全双工实时通话" @close="testing = false" @open-work="(id, title) => emit('open-work', id, title)" />
  <VoiceInputDialog v-if="testing && settings.voiceMode === 'input'" test-mode @close="testing = false" @transcript="message = '测试文字已确认，未发送给 Agent。'" />
</template>

<style scoped>
.box{border:1px solid var(--border);border-radius:1rem;padding:1.25rem}.label{display:block;margin-bottom:.5rem;font-size:.875rem;font-weight:600}.hint{display:block;margin-top:.25rem;color:var(--muted);font-size:.75rem}.field{min-width:0;border:1px solid var(--border);border-radius:.75rem;background:var(--surface-muted);padding:.7rem .9rem;font-size:.875rem}.primary{border-radius:.75rem;background:var(--accent);padding:.7rem 1.1rem;color:white;font-size:.875rem;font-weight:700}.secondary{border:1px solid var(--border);border-radius:.75rem;padding:.7rem 1rem;font-size:.8rem;font-weight:600}.primary:disabled,.secondary:disabled{opacity:.5}.check{display:flex;align-items:center;gap:.5rem;font-size:.8rem}.check input{accent-color:var(--accent)}.range-label{margin-bottom:.5rem;display:flex;justify-content:space-between;font-size:.875rem;font-weight:600}.range-label button{font-size:.75rem;color:var(--accent)}.range-value{min-width:3rem;border:1px solid var(--border);border-radius:.6rem;padding:.35rem;text-align:center;font-size:.75rem}
.voice-capability{display:flex;align-items:center;justify-content:space-between;gap:1rem;border:1px solid var(--border);border-radius:14px;background:var(--surface-muted);padding:14px;text-align:left;transition:border-color .18s,background .18s,box-shadow .18s}.voice-capability:hover{border-color:color-mix(in srgb,var(--accent) 35%,var(--border))}.voice-capability-active{border-color:var(--accent);background:var(--accent-soft);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 10%,transparent)}.voice-capability span{display:flex;flex-direction:column;gap:4px}.voice-capability small{color:var(--muted);font-size:11px}.voice-capability em{border-radius:999px;background:var(--surface);padding:4px 8px;color:var(--muted);font-size:10px;font-style:normal}.voice-capability em.ready{background:rgb(16 185 129/.12);color:#047857}
</style>
