import {AsyncLocalStorage} from 'node:async_hooks';
import type {KnowledgeBaseRuntime,ExperienceSettingsState} from '@openclawx/contracts';
import type {ExperienceRecord} from './types.js';
export type ExperienceContext={userId:string;orgId:string;settings:ExperienceSettingsState;target?:KnowledgeBaseRuntime;authorize?():Promise<void>;isTargetCurrent?():Promise<boolean>;sync?(record:ExperienceRecord):Promise<void>;search?(query:string):Promise<Array<{id:string;score:number}>>};
const context=new AsyncLocalStorage<ExperienceContext|null|undefined>();
export const withExperienceContext=<T>(value:ExperienceContext|null|undefined,run:()=>T):T=>context.run(value,run);
export const currentExperienceContext=()=>context.getStore();
