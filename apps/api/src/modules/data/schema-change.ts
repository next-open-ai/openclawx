import sqlParser from 'node-sql-parser';
import { createHash } from 'node:crypto';
import { dataSchemaProposalSchema } from '@workmate/contracts';
import { StructuredQueryError } from './structured-query.js';
const parser=new sqlParser.Parser();
const fail=(message:string):never=>{throw new StructuredQueryError(message,'DATA_SCHEMA_SQL_INVALID',400);};
const identifier=(name:unknown)=>{if(typeof name!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(name))fail('新表、字段及索引名仅支持字母开头的字母、数字、下划线（最多63字符）。');return name as string;};
const only=(node:Record<string,unknown>,keys:string[])=>{for(const [key,value] of Object.entries(node))if(value!=null&&!keys.includes(key))fail(`首期不支持结构定义 ${key}。`);};
const types=new Set(['INT','INTEGER','BIGINT','SMALLINT','TINYINT','VARCHAR','CHAR','TEXT','DECIMAL','NUMERIC','BOOLEAN','BOOL','BIT','DATE','DATETIME','TIMESTAMP','FLOAT','DOUBLE','REAL']);
export function compileSchemaProposal(raw:unknown,database:string){
  const parsed=dataSchemaProposalSchema.safeParse(raw);if(!parsed.success)return fail('建表方案需要说明及1–10条SQL，每条最多6000字符。');
  const input=parsed.data,created=new Map<string,Set<string>>(),sql:string[]=[],indexes=new Set<string>(),names:string[]=[];
  if(!/^[\p{L}\p{N}_$ -]{1,128}$/u.test(database))fail('当前数据库名称暂不支持结构创建。');
  for(const text of input.sql){
    if(/\/\*|--|#/.test(text))fail('结构 SQL 不允许注释或版本条件执行。');
    let ast:any;try{ast=parser.astify(text,{database:'MySQL'});}catch{fail('请提供单条 MySQL CREATE TABLE 或 CREATE INDEX。');}
    if(Array.isArray(ast)){if(ast.length!==1)fail('每项只允许一条 CREATE 语句。');ast=ast[0];}
    if(ast.type!=='create'||!['table','index'].includes(ast.keyword))fail('首期仅支持新增表及新表索引，不支持 ALTER/DROP/TRUNCATE 或数据写入。');
    if(ast.keyword==='table'){
      only(ast,['type','keyword','table','create_definitions','table_options']);
      if(ast.table?.length!==1||ast.table[0].as)fail('仅支持普通持久化表。');
      const ref=ast.table[0],name=identifier(ref.table);if(ref.db&&ref.db!==database)fail('不能跨数据库建表。');if(created.has(name.toLowerCase()))fail('方案中存在重复表名。');
      const fields=new Set<string>();let primary=false;
      if(!ast.create_definitions?.length||ast.create_definitions.length>100)fail('每张新表需要1–100个字段定义。');
      for(const def of ast.create_definitions){
        if(def.resource==='column'){
          only(def,['resource','column','definition','nullable','primary_key','auto_increment','unique','default_val','comment']);
          const field=identifier(def.column?.column);if(fields.has(field))fail('字段名重复。');fields.add(field);
          if(!types.has(def.definition?.dataType))fail('不支持该字段类型，请使用整数、文本、小数、日期或布尔类型。');
          only(def.definition,['dataType','length','scale','parentheses','suffix']);
          if(def.definition.suffix?.some((v:string)=>!['UNSIGNED','ZEROFILL'].includes(v.toUpperCase())))fail('不支持字段类型后缀。');
          if(def.primary_key)primary=true;
          if(def.comment)fail('首期请在对象字段说明中填写注释，不在DDL中填写 COMMENT。');
          const value=def.default_val?.value;
          if(value&&['single_quote_string','double_quote_string','string'].includes(value.type)&&/['"\\\0]/.test(String(value.value)))fail('默认文本暂不支持引号、反斜线或控制字符。');
          if(value&&!['number','bool','null','single_quote_string','double_quote_string','string'].includes(value.type)){
            const name=value.name?.name?.map((n:any)=>n.value).join('.');if(value.type!=='function'||!['CURRENT_TIMESTAMP','CURRENT_DATE'].includes(String(name).toUpperCase())||value.args?.value?.length||value.over)fail('默认值只允许常量或 CURRENT_TIMESTAMP/CURRENT_DATE。');
          }
        }else if(def.resource==='constraint'){
          only(def,['resource','constraint','definition','constraint_type','keyword','index_type','index','index_options']);
          if(!['primary key','unique key'].includes(def.constraint_type)||def.index_options||def.constraint)fail('首期仅支持主键和唯一键约束，不支持外键/CHECK。');
          if(def.index)identifier(def.index);if(def.constraint_type==='primary key')primary=true;
        }else fail('不支持该建表结构。');
      }
      for(const def of ast.create_definitions.filter((d:any)=>d.resource==='constraint'))for(const col of def.definition||[])if(!fields.has(col.column))fail('索引引用了未知字段。');
      if(!primary)fail('新业务表需要显式主键。');
      if(ast.table_options?.some((o:any)=>o.keyword?.toLowerCase()!=='engine'||String(o.value).toLowerCase()!=='innodb'))fail('新表仅支持 InnoDB；不支持其他表选项。');
      ast.table_options=[{keyword:'engine',symbol:'=',value:'InnoDB'}];ref.db=database;created.set(name.toLowerCase(),fields);names.push(name);
    }else{
      only(ast,['type','keyword','index_type','index','on_kw','table','index_columns','index_using','index_options','algorithm_option','lock_option']);
      const ref=ast.table,name=identifier(ref?.table),index=identifier(ast.index);if(ref.db&&ref.db!==database)fail('不能跨数据库建索引。');
      if(!created.has(name.toLowerCase())||indexes.has(index.toLowerCase()))fail('索引仅能用于本方案新建表，且索引名不能重复。');
      if(ast.index_type&&!['unique'].includes(String(ast.index_type).toLowerCase())||ast.index_using||ast.index_options||ast.algorithm_option||ast.lock_option)fail('仅支持普通或唯一索引。');
      for(const col of ast.index_columns||[])if(col.type!=='column_ref'||!created.get(name.toLowerCase())!.has(col.column)||col.collate||col.table)fail('索引只支持本表字段。');
      ref.db=database;indexes.add(index.toLowerCase());
    }
    sql.push(parser.sqlify(ast,{database:'MySQL'}));
  }
  if(!created.size||created.size>5)fail('一个方案需要1–5张新表，索引只能跟在新表之后。');
  const revision=createHash('sha256').update(JSON.stringify({database,description:input.description,sql})).digest('hex');
  return {description:input.description,sql,tables:names,revision};
}
