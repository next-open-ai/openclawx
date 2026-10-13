import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {experienceRoot} from './paths.js';
import type {ExperienceRecord} from './types.js';
import {experienceFileMirror} from './file-mirror.js';
type DB={run(sql:string,args?:unknown[]):void;exec(sql:string,args?:unknown[]):{values:unknown[][]}[];export():Uint8Array};
const databases=new Map<string,Promise<DB>>();
function atomic(file:string,data:string|Uint8Array){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(tmp,data,{mode:0o600});fs.renameSync(tmp,file);}catch(e){try{fs.unlinkSync(tmp);}catch{}throw e;}}
async function database(){
  const root=experienceRoot();let promise=databases.get(root);
  if(!promise){promise=(async()=>{
    const require=createRequire(typeof __filename==='string'?__filename:import.meta.url),init=require('sql.js');
    const SQL=await init({wasmBinary:fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'))});
    fs.mkdirSync(root,{recursive:true,mode:0o700});const file=path.join(root,'experience.sqlite');
    const exists=fs.existsSync(file),db:DB=exists?new SQL.Database(fs.readFileSync(file)):new SQL.Database();
    db.run('CREATE TABLE IF NOT EXISTS experiences(id TEXT PRIMARY KEY,record_json TEXT NOT NULL,updated_at INTEGER NOT NULL)');
    if(exists)for(const row of db.exec('SELECT id,record_json FROM experiences')[0]?.values||[]){const record=JSON.parse(String(row[1]));if(record.syncState==='queued'){record.syncState='failed';db.run('UPDATE experiences SET record_json=? WHERE id=?',[JSON.stringify(record),row[0]]);}}
    if(!exists){
      for(const entry of fs.readdirSync(root,{withFileTypes:true})){if(!entry.isDirectory()||entry.isSymbolicLink()||entry.name==='cards')continue;
        const old=path.join(root,entry.name,'experiences.json');if(!fs.existsSync(old))continue;
        const rows=JSON.parse(fs.readFileSync(old,'utf8'));if(!Array.isArray(rows))throw Error('旧经验文件不是数组；已保留文件，请检查后重试。');
        for(const row of rows){if(typeof row.id!=='string'||typeof row.situation!=='string'||typeof row.action!=='string')continue;const record={...row,id:randomUUID(),title:String(row.title||'Experience'),pitfall:String(row.pitfall||''),whenNot:String(row.whenNot||''),tags:Array.isArray(row.tags)?row.tags:[],embedText:String(row.embedText||[row.title,row.situation,row.action].filter(Boolean).join('\n')),agentId:row.agentId||entry.name,userId:row.userId||'legacy-unknown',orgId:row.orgId||'legacy-unknown'};db.run('INSERT INTO experiences VALUES(?,?,?)',[record.id,JSON.stringify(record),Number(record.updatedAt)||Date.now()]);}
      }
    }
    atomic(file,db.export());return db;
  })();databases.set(root,promise);promise.catch(()=>databases.delete(root));}
  return promise;
}
export async function listLocalExperiences(){const db=await database();return (db.exec('SELECT record_json FROM experiences ORDER BY updated_at DESC LIMIT 4000')[0]?.values||[]).map(row=>JSON.parse(String(row[0])) as ExperienceRecord);}
export async function putLocalExperience(record:ExperienceRecord){
  const db=await database(),root=experienceRoot();db.run('BEGIN');
  try{db.run('INSERT OR REPLACE INTO experiences VALUES(?,?,?)',[record.id,JSON.stringify(record),record.updatedAt]);db.run('COMMIT');}catch(e){db.run('ROLLBACK');throw e;}
  atomic(path.join(root,'experience.sqlite'),db.export());
  // Capture root and content now: later writes must not inherit another run's environment.
  const mirrorState=experienceFileMirror.enqueue(path.join(root,'cards',record.id+'.json'),JSON.stringify(record));
  return {mirrorSaved:false as const,mirrorState};
}
