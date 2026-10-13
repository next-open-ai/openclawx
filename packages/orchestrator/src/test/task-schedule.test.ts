import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskScheduleSchema,type TaskSchedule} from '@workmate/contracts';
import {nextTaskSchedule} from '../task-schedule.js';
import {TemplateTaskService} from '../template-tasks.js';
import {MemoryStore} from '../storage/memory.js';

const owner={orgId:'org',userId:'alice'};
const input={mode:'direct',name:'定时任务',employeeId:'general',prompt:'生成日报'};
test('TP-T11: schedule contract rejects invalid dates, intervals, week selection and timezone',()=>{
 for(const schedule of [{kind:'interval',everyMinutes:0},{kind:'weekly',time:'09:00',timezone:'UTC',weekdays:[]},{kind:'weekly',time:'09:00',timezone:'UTC',weekdays:[1,1]},{kind:'daily',time:'24:00',timezone:'UTC'},{kind:'daily',time:'09:00',timezone:'Mars/City'},{kind:'monthly',time:'09:00',timezone:'UTC',dayOfMonth:32},{kind:'once',at:NaN}])assert.equal(TaskScheduleSchema.safeParse(schedule).success,false);
});
test('TP-T11: next time handles timezone, daily/weekly/monthly boundaries and DST gaps',()=>{
 const next=(value:unknown,from:string)=>new Date(nextTaskSchedule(TaskScheduleSchema.parse(value),Date.parse(from))!).toISOString();
 assert.equal(next({kind:'daily',time:'09:00',timezone:'Asia/Shanghai'},'2026-10-11T01:00:00Z'),'2026-10-12T01:00:00.000Z');
 assert.equal(next({kind:'weekly',time:'09:00',timezone:'UTC',weekdays:[1,5]},'2026-10-11T12:00:00Z'),'2026-10-12T09:00:00.000Z');
 assert.equal(next({kind:'monthly',time:'09:00',timezone:'UTC',dayOfMonth:31},'2026-02-01T00:00:00Z'),'2026-02-28T09:00:00.000Z');
 assert.equal(next({kind:'daily',time:'02:30',timezone:'America/New_York'},'2026-03-08T00:00:00Z'),'2026-03-09T06:30:00.000Z');
 assert.equal(nextTaskSchedule({kind:'manual'},Date.now()),null);
});
test('TP-T11: once runs exactly once; periodic missed slots collapse; records contain trigger and json-result',async()=>{
 const store=new MemoryStore();let calls=0;
 const service=new TemplateTaskService(store,undefined,undefined,async()=>{calls++;return {text:'done'};});
 const once=await service.save(owner,{...input,schedule:{kind:'once',at:Date.now()+60_000}});
 const due=once.scheduleState!.nextRunAt!;
 await Promise.all([service.tickScheduled(due),service.tickScheduled(due)]);
 await service.tickScheduled(due+3600_000);
 assert.equal(calls,1);const history=await service.detail(owner,once.id);
 assert.equal(history.runs.length,1);assert.equal(history.runs[0].trigger,'scheduled');assert.equal(history.runs[0].scheduledFor,due);
 assert.equal(history.runs[0].jsonResult!.trigger,'scheduled');assert.equal(history.runs[0].jsonResult!.data!.text,'done');assert.equal(history.task.scheduleState!.nextRunAt,null);
 const periodic=await service.save({...owner,userId:'bob'},{...input,schedule:{kind:'interval',everyMinutes:10}});
 const missed=periodic.scheduleState!.nextRunAt!+3600_000+12345;
 await service.tickScheduled(missed);await service.tickScheduled(missed);
 assert.equal(calls,2);assert.equal((await service.get({...owner,userId:'bob'},periodic.id)).scheduleState!.nextRunAt,missed-12345+600_000);
 assert.equal((await service.runs(owner)).length,1);assert.equal((await service.runs({...owner,userId:'bob'})).length,1);
 await assert.rejects(service.save(owner,{...input,schedule:{kind:'once',at:Date.now()-1}}),/晚于当前时间/);
});
test('TP-T11: editing preserves deadline; pause/resume, restart and manual execution do not duplicate triggers',async()=>{
 const store=new MemoryStore();const service=new TemplateTaskService(store,undefined,undefined,async()=>({text:'done'}));
 let task=await service.save(owner,{...input,schedule:{kind:'interval',everyMinutes:60}});
 const original=task.scheduleState!.nextRunAt;
 task=await service.save(owner,{...input,prompt:'新提示词'},task.id,task.revision);
 assert.equal(task.scheduleState!.nextRunAt,original,'old clients omitting schedule must preserve it');
 await assert.rejects(service.updateSchedule({...owner,userId:'stranger'},task.id,{revision:task.revision,schedule:{kind:'manual'}}),/不存在/);
 await assert.rejects(service.updateSchedule(owner,task.id,{revision:0,schedule:{kind:'manual'}}));
 task=await service.updateSchedule(owner,task.id,{revision:task.revision,schedule:{kind:'interval',everyMinutes:60,enabled:false}});
 await assert.rejects(service.updateSchedule(owner,task.id,{revision:task.revision-1,schedule:{kind:'manual'}}),/已更新/);
 await service.tickScheduled(Date.now()+86_400_000);assert.equal((await service.detail(owner,task.id)).runs.length,0);
 task=await service.save(owner,{...input,schedule:{kind:'interval',everyMinutes:60,enabled:true}},task.id,task.revision);
 await service.run(owner,task.id,'manual');assert.equal((await service.get(owner,task.id)).scheduleState!.nextRunAt,task.scheduleState!.nextRunAt);
 const restarted=new TemplateTaskService(store,undefined,undefined,async()=>{throw new Error('余额不足');});
 await restarted.recoverInterrupted();await restarted.tickScheduled(task.scheduleState!.nextRunAt!);
 const detail=await restarted.detail(owner,task.id);
 assert.equal(detail.runs.length,2);assert.equal(detail.runs.find(run=>run.trigger==='scheduled')!.jsonResult!.error,'余额不足');
});
test('TP-T11: scheduler delays a task already executing, and manual/scheduled execution never overlaps',async()=>{
 const store=new MemoryStore();let release!:()=>void,started!:()=>void;
 const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);let calls=0,active=0,max=0;
 const service=new TemplateTaskService(store,undefined,undefined,async()=>{calls++;active++;max=Math.max(max,active);started();if(calls===1)await gate;active--;return {text:'done'};});
 const task=await service.save(owner,{...input,schedule:{kind:'interval',everyMinutes:1}});
 const manual=service.run(owner,task.id,'first');await entered;
 await service.tickScheduled(task.scheduleState!.nextRunAt!);assert.equal(calls,1);
 release();await manual;await service.tickScheduled(task.scheduleState!.nextRunAt!);
 assert.equal(calls,2);assert.equal(max,1);
});
