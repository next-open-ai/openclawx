import {TaskParameterSkillListSchema} from '@workmate/contracts';
import type {KeyValueStore,TaskOwner} from '@workmate/orchestrator';

/** Metadata selection does not grant or execute a Skill. Never read another user's catalog. */
export async function parameterSkillOptions(store:KeyValueStore,owner:TaskOwner) {
  const key='capabilities.skills.v2';
  const scoped=await store.get(`user:${owner.userId}:${key}`);
  const raw=scoped??await store.get(key);
  const rows:unknown=raw?JSON.parse(raw):[];
  const skills=Array.isArray(rows)?rows.filter(row=>row&&typeof row.id==='string'&&row.id.length>0&&row.id.length<=120&&row.status==='ready'&&!row.systemOnly).slice(0,1000).map(row=>({
    id:row.id,name:String(row.name||row.id).slice(0,200),description:String(row.description||'').slice(0,1000),
  })):[];
  return TaskParameterSkillListSchema.parse({skills});
}
