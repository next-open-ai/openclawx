import {z} from 'zod';
export const experienceSettingsSchema=z.object({enabled:z.boolean().default(true),knowledgeBaseId:z.string().trim().min(1).max(240).nullable().default(null)}).strict();
export type ExperienceSettings=z.infer<typeof experienceSettingsSchema>;
export type ExperienceSettingsState=ExperienceSettings&{available:boolean;fingerprint?:string;checkedAt?:number;message?:string};
