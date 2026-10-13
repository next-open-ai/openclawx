import {z} from 'zod';

const timezone=z.string().max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'请选择有效时区');
const time=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/,'时间格式应为 HH:mm');
const enabled=z.boolean().default(true);
export const TaskScheduleSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('manual')}).strict(),
  z.object({kind:z.literal('once'),at:z.number().int().positive().max(8_640_000_000_000_000),enabled}).strict(),
  z.object({kind:z.literal('interval'),everyMinutes:z.number().int().min(1).max(525600),enabled}).strict(),
  z.object({kind:z.literal('daily'),time,timezone,enabled}).strict(),
  z.object({kind:z.literal('weekly'),time,timezone,weekdays:z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(days=>new Set(days).size===days.length,'星期不能重复'),enabled}).strict(),
  z.object({kind:z.literal('monthly'),time,timezone,dayOfMonth:z.number().int().min(1).max(31),enabled}).strict(),
]);
export type TaskSchedule=z.infer<typeof TaskScheduleSchema>;
export const TaskScheduleUpdateSchema=z.object({revision:z.number().int().positive(),schedule:TaskScheduleSchema}).strict();
export interface TaskScheduleState {nextRunAt:number|null;lastScheduledAt?:number;lastError?:string}
