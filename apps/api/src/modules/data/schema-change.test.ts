import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {compileSchemaProposal} from './schema-change.js';
import {createSchemaChangeService,migrateSchemaChanges} from './schema-change-service.js';
import type {RemoteFactory} from './remote-database.js';
const input=(name='notes')=>({description:'新增业务记录',sql:[`CREATE TABLE ${name} (id BIGINT PRIMARY KEY AUTO_INCREMENT, title VARCHAR(80) NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,`CREATE INDEX ix_${name} ON ${name}(title)`]});
test('MDA-T22: deterministic qualified InnoDB CREATE plan; destructive and unsafe SQL rejected',()=>{
  const p=compileSchemaProposal(input('BusinessNotes'),'business-db');assert.match(p.sql[0],/`business-db`\.`BusinessNotes`/);assert.match(p.sql[0],/InnoDB/);assert.equal(p.tables[0],'BusinessNotes');
  assert.equal(compileSchemaProposal({description:p.description,sql:p.sql},'business-db').revision,p.revision);
  for(const sql of ['DROP TABLE notes','ALTER TABLE notes ADD x INT','TRUNCATE TABLE notes','CREATE TEMPORARY TABLE notes(id INT PRIMARY KEY)','CREATE TABLE notes AS SELECT * FROM secrets','CREATE TABLE other.notes(id INT PRIMARY KEY)','CREATE TABLE notes(id INT)','CREATE TABLE notes(id INT PRIMARY KEY) ENGINE=MyISAM','CREATE TABLE notes(id INT PRIMARY KEY, x VARCHAR(10) DEFAULT (load_file("x")))','CREATE TABLE notes(id INT PRIMARY KEY); DROP TABLE old','CREATE TABLE notes(id INT PRIMARY KEY) /*! DROP TABLE old */','CREATE TABLE notes(id INT PRIMARY KEY, owner INT REFERENCES old(id))'])assert.throws(()=>compileSchemaProposal({description:'bad',sql:[sql]},'business'),sql);
  assert.throws(()=>compileSchemaProposal({description:'bad',sql:['CREATE TABLE notes(id INT PRIMARY KEY)','CREATE INDEX ix_old ON old(id)']},'business'));
});
test('MDA-T22: schema permission, exact approval, real metadata import, partial/unknown result and restart recovery',async()=>{
  const require=createRequire(import.meta.url),root=path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
  const SQL=await require(path.join(root,'sql-wasm.js'))({wasmBinary:fs.readFileSync(path.join(root,'sql-wasm.wasm'))}),db=new SQL.Database();
  db.run('CREATE TABLE data_live_objects(source_id TEXT PRIMARY KEY,binding_json TEXT)');migrateSchemaChanges(db);
  db.run('INSERT INTO data_live_objects VALUES(?,?)',['source',JSON.stringify({connectionId:'c',database:'business',writeEnabled:false,tables:{}})]);
  const created=new Set<string>(),calls:string[]=[],imports:Array<{appId:string;names:string[]}>=[];let failure='';
  const factory:RemoteFactory=async()=>({async query(sql,values=[]){calls.push(sql);if(sql.includes('COUNT(*) AS n'))return [{n:created.has(String(values[1]))?1:0}];
    if(sql.startsWith('CREATE TABLE')){created.add(sql.match(/`business`\.`([^`]+)`/)![1]);return [];}
    if(sql.startsWith('CREATE INDEX')&&failure)throw Object.assign(new Error('private database details'),{code:failure});
    if(sql.includes('TABLE_TYPE'))return [...created].map(name=>({schema_name:'business',table_name:name,table_engine:'InnoDB'}));
    if(sql.includes('COLUMNS'))return [{name:'id',data_type:'bigint',nullable:'NO',key_type:'PRI',extra:'auto_increment'},{name:'title',data_type:'varchar',nullable:'NO'}];return[];
  },async close(){},destroy(){}});
  const owner={userId:'u',orgId:'o',role:'admin'};
  const service=createSchemaChangeService({database:async()=>db,flush:()=>{},source:(_db,id,auth)=>id==='source'&&auth.userId==='u'&&auth.orgId==='o'?{}:null,binding:()=>JSON.parse(String(db.exec('SELECT binding_json FROM data_live_objects')[0].values[0][0])),connection:async()=>({engine:'mysql',host:'localhost',port:3306,user:'test',password:'synthetic',database:'business',tls:false,ca:''}),include:(_db,_id,tables,_owner,appId)=>{imports.push({appId,names:tables.map(t=>t.name)});return Object.fromEntries(tables.map(t=>[t.name+'-id',t.binding]));},factory});
  const plan=await service.propose('source',owner,input());assert.equal(calls.length,0);assert.equal(plan.state,'draft');
  assert.equal((await service.propose('source',owner,input())).id,plan.id);
  const consent={revision:plan.revision,confirmed:true,includeInObject:true};
  await assert.rejects(service.execute('source',plan.id,'app1',owner,consent),/结构创建权限/);
  await assert.rejects(service.access('source',{...owner,role:'member'},{enabled:true,confirmed:true}),/管理员/);
  await service.access('source',owner,{enabled:true,confirmed:true});
  await assert.rejects(service.execute('source',plan.id,'app1',owner,{...consent,confirmed:false}));
  await assert.rejects(service.execute('source',plan.id,'app1',owner,{...consent,revision:'0'.repeat(64)}),/方案/);
  const [a,b]=await Promise.allSettled([service.execute('source',plan.id,'app1',owner,consent),service.execute('source',plan.id,'app1',owner,consent)]);
  assert.equal(a.status,'fulfilled');assert.equal(b.status,'rejected');assert.equal((await service.list('source',owner))[0].state,'applied');assert.equal(calls.filter(s=>s.startsWith('CREATE TABLE')).length,1);
  assert.deepEqual(imports,[{appId:'app1',names:['notes']}]);assert.ok(!calls.some(s=>/DROP|ROLLBACK/.test(s))); // Never claim native DDL rollback.
  const binding=JSON.parse(String(db.exec('SELECT binding_json FROM data_live_objects')[0].values[0][0]));assert.equal(binding.writeEnabled,false);assert.ok(binding.tables['notes-id']);
  failure='ER_DUP_KEYNAME';const partial=await service.propose('source',owner,input('partial_notes'));
  const partialResult=await service.execute('source',partial.id,'app1',owner,{...consent,revision:partial.revision});assert.equal(partialResult.state,'partial');assert.equal(partialResult.completed,1);assert.equal(imports.length,1);assert.ok(!partialResult.error?.includes('private'));
  failure='ECONNRESET';const uncertain=await service.propose('source',owner,input('uncertain_notes'));
  assert.equal((await service.execute('source',uncertain.id,'app1',owner,{...consent,revision:uncertain.revision})).state,'unconfirmed');
  await assert.rejects(service.list('source',{...owner,userId:'other'}),/无权/);
  const interrupted={...plan,id:'interrupted',state:'executing'};db.run('INSERT INTO data_schema_changes VALUES(?,?,?,?)',['interrupted','source',JSON.stringify(interrupted),Date.now()]);migrateSchemaChanges(db);assert.equal((await service.list('source',owner)).find(p=>p.id==='interrupted')?.state,'unconfirmed');
  db.close();
});
