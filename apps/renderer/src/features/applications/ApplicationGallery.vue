<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { listDataApps, type DataApp } from '../../services/api';
import { openExternalBestEffort } from '../../app/platform-actions';
import { qrDataUrl } from '../../app/qr-data-url';
import BrandLogo from '../../app/BrandLogo.vue';
import { appAccessUrl, galleryApps, formatAppTime, appModifiedAt, type AppSort } from '../data/workbench-presentation';

const emit=defineEmits<{close:[]}>();
const modal=ref<HTMLDialogElement>(), apps=ref<DataApp[]>([]), loading=ref(false), error=ref(''), search=ref(''), sort=ref<AppSort>('updated');
const sharing=ref<DataApp>(), qr=ref(''), shareError=ref(''), copied=ref(false);
const available=computed(()=>galleryApps(apps.value));
const visible=computed(()=>galleryApps(apps.value,search.value,sort.value));
const shareUrl=computed(()=>sharing.value ? appAccessUrl(sharing.value,true) || appAccessUrl(sharing.value) : '');
let disposed=false, shareRequest=0;
async function load(){
  if(loading.value)return;
  loading.value=true; error.value='';
  try { const result=await listDataApps(); if(!disposed) apps.value=result; }
  catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'应用加载失败，请重试';}
  finally{if(!disposed)loading.value=false;}
}
async function open(app:DataApp){
  try{await openExternalBestEffort(appAccessUrl(app));}
  catch(cause){error.value=cause instanceof Error?cause.message:'无法打开应用，请复制访问链接';}
}
async function share(app:DataApp){
  const request=++shareRequest;
  sharing.value=app; qr.value=''; shareError.value=''; copied.value=false;
  const target=appAccessUrl(app,true);
  if(!target)return;
  try{const value=await qrDataUrl(target,220); if(!disposed&&request===shareRequest)qr.value=value;}
  catch{if(!disposed&&request===shareRequest)shareError.value='二维码生成失败，可复制下方链接。';}
}
async function copy(){
  const request=shareRequest;
  try{await navigator.clipboard.writeText(shareUrl.value); if(!disposed&&request===shareRequest)copied.value=true;}
  catch{if(!disposed&&request===shareRequest)shareError.value='无法访问剪贴板，请选中下方链接手动复制。';}
}
onMounted(()=>{modal.value?.showModal();void load();});
onBeforeUnmount(()=>{disposed=true;shareRequest++;modal.value?.close();});
</script>

<template>
  <dialog ref="modal" class="gallery" aria-labelledby="gallery-title" @cancel.prevent="emit('close')">
    <header class="gallery-bar"><div class="brand"><BrandLogo /><b>Workmate</b><span>应用大厅</span></div><button class="secondary" type="button" @click="emit('close')">返回工作台</button></header>
    <main class="gallery-content">
      <section class="intro"><p class="eyebrow">YOUR APPS, READY TO WORK</p><h1 id="gallery-title">让成果，成为日常工具。</h1><p>打开你已交付的应用，让真实数据开始工作。</p><div class="summary"><strong>{{ available.length }}</strong><span>个可用应用</span><span class="summary-note">本机运行 · 登录后使用</span></div></section>
      <div class="tools"><label class="search"><span class="sr-only">搜索应用</span><input v-model="search" type="search" placeholder="搜索应用名称…"></label><label class="sort"><span class="sr-only">应用排序</span><select v-model="sort"><option value="updated">最近更新</option><option value="name">按名称</option><option value="created">最新创建</option></select></label><button class="secondary" :disabled="loading" @click="load">{{ loading?'刷新中…':'刷新' }}</button></div>
      <div v-if="error" class="error" role="alert">{{ error }} <button type="button" @click="load">重试</button></div>
      <div v-if="loading && !apps.length" class="cards" aria-label="正在加载应用" aria-busy="true"><div v-for="i in 3" :key="i" class="skeleton" /></div>
      <section v-else-if="!visible.length" class="empty"><h2>{{ available.length?'没有找到匹配应用':'你的应用，即将在这里登场' }}</h2><p>{{ available.length?'换个关键词试试。':'在数据工作台创建并完成交付后，即可在这里打开使用。' }}</p><button class="secondary" @click="available.length ? search='' : emit('close')">{{ available.length?'清空搜索':'返回工作台' }}</button></section>
      <section v-else class="cards" aria-label="可用应用">
        <article v-for="(app,index) in visible" :key="app.id" class="app-card" :style="{'--tile':String(index%3)}">
          <div class="card-cover" :class="`cover-${index%3}`"><span class="app-monogram" aria-hidden="true">{{ app.name.slice(0,1) }}</span><span class="availability">已交付</span></div>
          <div class="card-body"><p class="app-type">{{ app.appType }}</p><h2>{{ app.name }}</h2><p class="updated">更新于 {{ formatAppTime(appModifiedAt(app)) }}</p><div class="card-actions"><button class="primary" type="button" @click="open(app)">打开使用 <span aria-hidden="true">↗</span></button><button class="secondary" type="button" :aria-label="`分享${app.name}的访问链接与二维码`" @click="share(app)">链接与二维码</button></div></div>
        </article>
      </section>
      <p class="footnote">这里只展示当前账号已发布、可打开的数据应用。访问链接不授予数据权限，Workmate 需保持运行。</p>
    </main>
    <div v-if="sharing" class="share-shade" @click.self="sharing=undefined; shareRequest++"><section class="share-panel" role="region" aria-label="应用分享"><div class="share-heading"><h2>{{ sharing.name }}</h2><button class="secondary" @click="sharing=undefined; shareRequest++">关闭</button></div><img v-if="qr" :src="qr" alt="应用局域网访问二维码" width="220" height="220"><p v-else-if="!appAccessUrl(sharing,true)">暂无局域网地址；下面是仅供本机使用的链接。</p><p v-else-if="!shareError">正在生成二维码…</p><p v-if="shareError" class="error" role="alert">{{ shareError }}</p><label>访问链接<input :value="shareUrl" readonly aria-label="应用访问链接" @focus="($event.target as HTMLInputElement).select()"></label><button class="primary" @click="copy">{{ copied?'已复制':'复制链接' }}</button><p>手机请连接同一局域网，并使用 Workmate 账号登录。链接不会公开数据库或绕过访问权限。</p></section></div>
  </dialog>
</template>

<style scoped>
.gallery{position:fixed;inset:0;width:100vw;max-width:none;height:100dvh;max-height:none;margin:0;padding:0;border:0;background:var(--background);color:var(--text);overflow:auto}.gallery::backdrop{background:var(--background)}
.gallery-bar{height:80px;padding:0 clamp(20px,5vw,80px);display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);background:var(--surface)}.brand{display:flex;align-items:center;gap:12px}.brand span{padding-left:16px;border-left:1px solid var(--border);font-size:13px;color:var(--muted)}
.gallery-content{max-width:1360px;margin:auto;padding:50px clamp(20px,5vw,64px) 40px}.intro{position:relative}.eyebrow{color:var(--accent);font-size:11px;letter-spacing:.14em;font-weight:700}.intro h1{font-size:clamp(28px,3vw,44px);line-height:1.25;letter-spacing:-.04em;margin:14px 0}.intro>p:not(.eyebrow){color:var(--muted);font-size:14px}.summary{display:flex;align-items:baseline;gap:10px;margin:26px 0 30px;font-size:13px;color:var(--muted)}.summary strong{font-size:28px;color:var(--text)}.summary-note{margin-left:16px;padding-left:24px;border-left:1px solid var(--border)}
.tools{display:flex;gap:12px;margin:0 0 24px}.search{flex:1}.tools input,.tools select,.share-panel input{width:100%;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px;font-size:13px;color:var(--text)}.sort{min-width:140px}
button{white-space:nowrap;cursor:pointer;border-radius:10px;padding:11px 16px;font-size:12px;font-weight:600;transition:transform .16s,box-shadow .16s}button:active{transform:scale(.98)}button:disabled{opacity:.5;cursor:wait}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.primary{background:var(--accent);color:#fff;border:1px solid var(--accent)}.secondary{background:var(--surface);color:var(--text);border:1px solid var(--border)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:24px}.app-card{border:1px solid var(--border);background:var(--surface);border-radius:20px;overflow:hidden;transition:transform .18s,box-shadow .18s}.app-card:hover{transform:translateY(-4px);box-shadow:0 16px 36px color-mix(in srgb,var(--accent) 10%,transparent)}.card-cover{height:150px;display:flex;justify-content:space-between;align-items:flex-start;padding:24px;background:color-mix(in srgb,var(--accent) 12%,var(--surface))}.cover-1{background:repeating-linear-gradient(135deg,transparent 0 20px,color-mix(in srgb,var(--accent) 6%,transparent) 20px 21px),var(--surface-muted)}.cover-2{background:radial-gradient(ellipse at 85% 20%,color-mix(in srgb,var(--accent) 22%,transparent),transparent 65%),var(--surface-muted)}.app-monogram{display:grid;place-items:center;width:64px;height:64px;border-radius:18px;background:var(--accent);color:white;font-size:26px;font-weight:700;box-shadow:0 8px 20px color-mix(in srgb,var(--accent) 20%,transparent)}.availability{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px 8px;font-size:10px;color:var(--muted)}
.card-body{padding:24px}.app-type{font-size:11px;color:var(--muted);margin:0 0 8px}.card-body h2{font-size:21px;line-height:1.4;overflow-wrap:anywhere;margin:0}.updated{font-size:11px;color:var(--muted);margin:12px 0 24px}.card-actions{display:flex;gap:10px;flex-wrap:wrap}.card-actions .primary{flex:1;display:flex;justify-content:space-between;gap:12px}.footnote{font-size:11px;color:var(--muted);line-height:1.8;margin-top:28px}.empty{padding:70px 20px;text-align:center;border:1px dashed var(--border);border-radius:20px}.empty h2{font-size:22px}.empty p{color:var(--muted);font-size:13px;margin:16px 0 24px}.error{padding:12px;color:var(--text);background:var(--surface-muted);border-left:3px solid #e05252;margin-bottom:16px;font-size:13px}.error button{margin-left:8px;text-decoration:underline}.skeleton{height:330px;background:var(--surface-muted);border-radius:20px;border:1px solid var(--border)}
.share-shade{position:fixed;inset:0;background:#0007;display:grid;place-items:center;padding:24px;z-index:2}.share-panel{width:min(100%,450px);max-height:90dvh;overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:24px}.share-heading{display:flex;justify-content:space-between;gap:12px;align-items:center}.share-heading h2{font-size:19px;overflow-wrap:anywhere}.share-panel img{display:block;margin:20px auto;border-radius:12px}.share-panel label{display:block;font-size:12px;margin:16px 0 12px}.share-panel input{display:block;margin-top:8px}.share-panel p{font-size:12px;line-height:1.8;color:var(--muted)}
@media(max-width:600px){.gallery-bar{height:68px;padding:0 20px}.brand span{display:none}.gallery-content{padding-top:30px}.tools{flex-wrap:wrap}.search{flex-basis:100%}.sort{flex:1}.summary-note{margin-left:0;padding-left:12px;font-size:11px}.cards{gap:16px}}
@media(prefers-reduced-motion:reduce){button,.app-card{transition:none}.app-card:hover,button:active{transform:none}}
</style>
