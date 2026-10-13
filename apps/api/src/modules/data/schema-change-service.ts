import { randomUUID } from 'node:crypto';
import { dataSchemaAccessSchema, dataSchemaExecuteSchema, type DataSchemaPlan, type RemoteDatabaseConnection } from '@workmate/contracts';
import { withKeyLock } from '@workmate/orchestrator';
import { compileSchemaProposal } from './schema-change.js';
import { session,remoteFactory,type RemoteFactory } from './remote-database.js';
import { discoverLiveTables,type LiveTable,LiveDataError } from './live-database.js';
type Db={exec(sql:string,values?:unknown[]):{values?:unknown[][]}[];run(sql:string,values?:unknown[]):void};
type Owner={userId:string;orgId:string;role?:string};
type Binding={connectionId:string;database:string;writeEnabled:boolean;schemaCreationEnabled?:boolean;tables:Record<string,LiveTable>};
type Discovered=Awaited<ReturnType<typeof discoverLiveTables>>;
const consent=<T>(parse:(raw:unknown)=>T,raw:unknown):T=>{try{return parse(raw);}catch{throw new LiveDataError('请刷新方案，并明确确认结构权限、方案版本及纳入当前对象。',400,'DATA_SCHEMA_CONSENT_REQUIRED');}};
type Dependencies={database():Promise<Db>;flush(db:Db):void;source(db:Db,id:string,owner:Owner):unknown;binding(db:Db,id:string):Binding|undefined;connection(db:Db,id:string,owner:Owner,database:string):Promise<RemoteDatabaseConnection>;include(db:Db,id:string,tables:Discovered,owner:Owner,appId:string):Record<string,LiveTable>;factory?:RemoteFactory};
export function migrateSchemaChanges(db:Db){
  db.run('CREATE TABLE IF NOT EXISTS data_schema_changes(id TEXT PRIMARY KEY, source_id TEXT NOT NULL, plan_json TEXT NOT NULL, created_at INTEGER NOT NULL)');
  for(const row of db.exec('SELECT id,plan_json FROM data_schema_changes')[0]?.values||[]){const p=JSON.parse(String(row[1])) as DataSchemaPlan;if(p.state==='executing'){p.state='unconfirmed';p.error='上次执行中断，结构结果未确认；请核对数据库，不会自动重试。';db.run('UPDATE data_schema_changes SET plan_json=? WHERE id=?',[JSON.stringify(p),row[0]]);}}
}
export function createSchemaChangeService(d:Dependencies){
  const persist=(db:Db,p:DataSchemaPlan)=>{db.run('INSERT OR REPLACE INTO data_schema_changes VALUES(?,?,?,?)',[p.id,p.sourceId,JSON.stringify(p),p.createdAt]);d.flush(db);};
  const resolve=(db:Db,id:string,owner:Owner)=>{if(!d.source(db,id,owner))throw new LiveDataError('对象不存在或无权访问。',404);const b=d.binding(db,id);if(!b)throw new LiveDataError('仅实时 MySQL 对象支持建表。',400,'DATA_SCHEMA_UNSUPPORTED');return b;};
  async function list(id:string,owner:Owner){const db=await d.database();resolve(db,id,owner);return (db.exec('SELECT plan_json FROM data_schema_changes WHERE source_id=? ORDER BY created_at DESC LIMIT 20',[id])[0]?.values||[]).map(r=>JSON.parse(String(r[0])) as DataSchemaPlan);}
  async function propose(id:string,owner:Owner,raw:unknown){
    return withKeyLock(`live-object:${id}`,async()=>{
      const db=await d.database(),b=resolve(db,id,owner),c=await d.connection(db,b.connectionId,owner,b.database);
      if(c.engine!=='mysql')throw new LiveDataError('首期结构创建仅支持 MySQL 实时对象。',400,'DATA_SCHEMA_UNSUPPORTED');
      const compiled=compileSchemaProposal(raw,b.database);
      if(compiled.tables.some(name=>Object.values(b.tables).some(t=>t.schema===b.database&&t.name.toLowerCase()===name.toLowerCase())))throw new LiveDataError('对象中已有同名表，请使用新表名。',409,'DATA_SCHEMA_CONFLICT');
      const prior=(await list(id,owner)).find(p=>p.revision===compiled.revision&&p.state==='draft');if(prior)return prior;
      const plan:DataSchemaPlan={id:randomUUID(),sourceId:id,...compiled,state:'draft',completed:0,createdAt:Date.now()};persist(db,plan);return plan;
    });
  }
  async function access(id:string,owner:Owner,raw:unknown){const input=consent(v=>dataSchemaAccessSchema.parse(v),raw);if(owner.role!=='admin')throw new LiveDataError('仅对象所有者管理员可以设置结构创建权限。',403);return withKeyLock(`live-object:${id}`,async()=>{const db=await d.database(),b=resolve(db,id,owner);b.schemaCreationEnabled=input.enabled;db.run('UPDATE data_live_objects SET binding_json=? WHERE source_id=?',[JSON.stringify(b),id]);d.flush(db);return {enabled:input.enabled};});}
  async function execute(id:string,planId:string,appId:string,owner:Owner,raw:unknown){
    const input=consent(v=>dataSchemaExecuteSchema.parse(v),raw);if(owner.role!=='admin')throw new LiveDataError('仅对象所有者管理员可以执行建表。',403);
    return withKeyLock(`live-object:${id}`,async()=>{
      const db=await d.database(),b=resolve(db,id,owner);
      if(!b.schemaCreationEnabled)throw new LiveDataError('请先明确开启本对象的结构创建权限（独立于CRUD写权限）。',403,'DATA_SCHEMA_DISABLED');
      const row=db.exec('SELECT plan_json FROM data_schema_changes WHERE id=? AND source_id=?',[planId,id])[0]?.values?.[0];
      if(!row)throw new LiveDataError('建表方案不存在。',404);
      const plan=JSON.parse(String(row[0])) as DataSchemaPlan;
      if(plan.revision!==input.revision||plan.state!=='draft')throw new LiveDataError('方案已执行、变化或结果未确认；不会重复执行。',409,'DATA_SCHEMA_PLAN_CHANGED');
      const c=await d.connection(db,b.connectionId,owner,b.database);if(c.engine!=='mysql')throw new LiveDataError('首期仅支持 MySQL。');
      const checked=compileSchemaProposal({description:plan.description,sql:plan.sql},b.database);
      if(checked.revision!==plan.revision)throw new LiveDataError('方案校验不一致，请重新生成。',409);
      return withKeyLock(`ddl-connection:${b.connectionId}`,async()=>{
        let attempting=false;
        try{
          await session(c,d.factory||remoteFactory,async s=>{
            for(const name of plan.tables){const rows=await s.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',[b.database,name]);if(!rows.length||Number(rows[0].n)!==0)throw new LiveDataError('数据库中已有同名表或无法确认表名冲突；未执行建表。',409,'DATA_SCHEMA_CONFLICT');}
            plan.state='executing';persist(db,plan);
            for(const sql of plan.sql){resolve(db,id,owner);attempting=true;await s.query(sql);attempting=false;plan.completed++;persist(db,plan);}
          });
          const tables=await discoverLiveTables(c,plan.tables.map(name=>({schema:b.database,name,transactional:true})),d.factory);
          resolve(db,id,owner);
          db.run('BEGIN');
          try{
            const included=d.include(db,id,tables,owner,appId);Object.assign(b.tables,included);
            db.run('UPDATE data_live_objects SET binding_json=? WHERE source_id=?',[JSON.stringify(b),id]);
            plan.tableIds=Object.keys(included);plan.state='applied';
            db.run('UPDATE data_schema_changes SET plan_json=? WHERE id=?',[JSON.stringify(plan),plan.id]);db.run('COMMIT');d.flush(db);
          }catch(error){db.run('ROLLBACK');throw error;}
          return plan;
        }catch(error){
          const code=String((error as {code?:unknown})?.code||'');
          plan.state=attempting&&!/^ER_[A-Z0-9_]+$/.test(code)?'unconfirmed':plan.completed?'partial':'failed';
          plan.error=error instanceof LiveDataError?error.message:`结构创建未完成${/^[A-Z0-9_]{2,64}$/.test(code)?`（${code}）`:''}。已完成 ${plan.completed}/${plan.sql.length} 条。请核对数据库；不会自动回滚、删表或重试。`;
          persist(db,plan);return plan;
        }
      });
    });
  }
  return {list,propose,access,execute};
}
