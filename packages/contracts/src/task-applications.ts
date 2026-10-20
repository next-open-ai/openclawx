import {z} from 'zod';
import {TaskScheduleSchema} from './task-schedule.js';
export const TaskApplicationCreateSchema=z.object({name:z.string().trim().min(1).max(120),description:z.string().trim().max(1000).default(''),employeeId:z.string().trim().min(1).max(120),prompt:z.string().trim().min(1).max(8000)}).strict();
export const TaskApplicationLaunchSchema=z.object({requestId:z.string().uuid(),version:z.string().min(1).max(40),name:z.string().trim().min(1).max(120),parameters:z.record(z.unknown()),schedule:TaskScheduleSchema.default({kind:'manual'}),executeNow:z.boolean().default(true)}).strict().refine(value=>value.executeNow?value.schedule.kind==='manual':value.schedule.kind!=='manual','立即执行请使用手动计划；定时任务请选择执行时间');
export type TaskApplicationCreate=z.infer<typeof TaskApplicationCreateSchema>;
export type TaskApplicationLaunch=z.infer<typeof TaskApplicationLaunchSchema>;
