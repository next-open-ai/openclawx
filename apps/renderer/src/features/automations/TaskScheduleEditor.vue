<script setup lang="ts">
import type {TaskSchedule} from '@workmate/contracts';
const props=defineProps<{modelValue:TaskSchedule;disabled?:boolean}>();
const emit=defineEmits<{'update:modelValue':[value:TaskSchedule]}>();
const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
function change(kind:TaskSchedule['kind']) {
  const base={enabled:true,time:'09:00',timezone:zone};
  emit('update:modelValue',kind==='manual'?{kind}:kind==='once'?{kind,enabled:true,at:Date.now()+3600_000}:kind==='interval'?{kind,enabled:true,everyMinutes:60}:kind==='weekly'?{...base,kind,weekdays:[1]}:kind==='monthly'?{...base,kind,dayOfMonth:1}:{...base,kind});
}
function patch(fields:Record<string,unknown>){emit('update:modelValue',{...props.modelValue,...fields} as TaskSchedule);}
function dateInput(epoch:number){const date=new Date(epoch);const pad=(n:number)=>String(n).padStart(2,'0');return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;}
function weekday(day:number,checked:boolean){if(props.modelValue.kind!=='weekly')return;patch({weekdays:checked?[...props.modelValue.weekdays,day].sort():props.modelValue.weekdays.filter(value=>value!==day)});}
</script>
<template>
  <fieldset class="schedule-editor" :disabled="disabled"><legend>执行时间</legend>
    <label>执行方式<select aria-label="执行方式" :value="modelValue.kind" @change="change(($event.target as HTMLSelectElement).value as TaskSchedule['kind'])"><option value="manual">手动执行</option><option value="once">指定时间执行一次</option><option value="interval">固定间隔</option><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option></select></label>
    <template v-if="modelValue.kind!=='manual'">
      <label v-if="modelValue.kind==='once'">执行日期与时间<input type="datetime-local" :value="dateInput(modelValue.at)" @change="patch({at:new Date(($event.target as HTMLInputElement).value).getTime()})"><small>按当前设备时区 {{zone}} 换算，保存为确定的时间点。</small></label>
      <label v-if="modelValue.kind==='interval'">间隔分钟<input type="number" min="1" max="525600" :value="modelValue.everyMinutes" @input="patch({everyMinutes:Number(($event.target as HTMLInputElement).value)})"></label>
      <label v-if="'time' in modelValue">执行时刻<input type="time" :value="modelValue.time" @input="patch({time:($event.target as HTMLInputElement).value})"></label>
      <div v-if="modelValue.kind==='weekly'" class="weekdays"><label v-for="(day,index) in ['日','一','二','三','四','五','六']" :key="day"><input type="checkbox" :checked="modelValue.weekdays.includes(index)" @change="weekday(index,($event.target as HTMLInputElement).checked)">周{{day}}</label></div>
      <label v-if="modelValue.kind==='monthly'">每月几号<input type="number" min="1" max="31" :value="modelValue.dayOfMonth" @input="patch({dayOfMonth:Number(($event.target as HTMLInputElement).value)})"><small>当月没有该日期时，在当月最后一天执行。</small></label>
      <details v-if="'timezone' in modelValue"><summary>时区 · {{modelValue.timezone}}</summary><label>执行时区<input aria-label="执行时区" :value="modelValue.timezone" placeholder="Asia/Shanghai" @change="patch({timezone:($event.target as HTMLInputElement).value})"></label></details>
      <label class="enabled"><input type="checkbox" :checked="modelValue.enabled" @change="patch({enabled:($event.target as HTMLInputElement).checked})">启用自动执行</label>
      <p>Workmate 服务运行时自动触发，关闭本页面不影响执行；退出应用后暂停。错过的周期最多执行一次，不积压补跑。每次执行仍保存独立运行记录。</p>
    </template>
  </fieldset>
</template>
<style scoped>
.schedule-editor{min-width:0;border:1px solid var(--border);border-radius:14px;padding:18px;margin:20px 0;display:grid;gap:14px}.schedule-editor legend{font-weight:600;padding:0 6px}.schedule-editor label{display:grid;gap:8px;font-size:14px}.schedule-editor input,.schedule-editor select{width:100%;min-width:0;font:inherit;border:1px solid var(--border);border-radius:9px;padding:10px;background:var(--surface);color:var(--text)}.schedule-editor .enabled,.schedule-editor .weekdays label{display:flex;align-items:center;gap:7px}.schedule-editor input[type=checkbox]{width:16px;height:16px;padding:0;accent-color:var(--accent)}.weekdays{display:flex;flex-wrap:wrap;gap:12px}.schedule-editor small,.schedule-editor p,.schedule-editor summary{font-size:12px;line-height:1.7;color:var(--muted)}.schedule-editor summary{cursor:pointer}
</style>
