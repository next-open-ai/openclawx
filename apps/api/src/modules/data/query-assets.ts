import {createHash,randomUUID} from 'node:crypto';
import {withKeyLock,type KeyValueStore} from '@openclawx/orchestrator';
import {saveQueryAssetSchema,listQueryAssetsSchema,runQueryAssetSchema,type QueryAsset,type QueryAssetDefinition,type DataObjectModelSchema} from '@openclawx/contracts';
import type {AgentDataGateway} from './agent-query.js';
import {StructuredQueryError} from './structured-query.js';
type Owner={userId:string;orgId:string};
type Receipt={id:string;sourceId:string;tableIds:string[];question:string;definition:QueryAssetDefinition;schemaFingerprint:string;createdAt:number};
const key=(owner:Owner)=>`query-assets:v1:${encodeURIComponent(owner.orgId)}:${encodeURIComponent(owner.userId)}`;
const receiptKey=(owner:Owner,sessionId:string)=>`${key(owner)}:receipts:${encodeURIComponent(sessionId)}`;
const deny=(message:string,code='QUERY_ASSET_INVALID'):never=>{throw new StructuredQueryError(message,code,400);};
async function read<T>(store:KeyValueStore,k:string,fallback:T):Promise<T>{const raw=await store.get(k);return raw?JSON.parse(raw) as T:fallback;}
export function explicitQuerySave(text:string){
  const value=text.trim().replace(/^(?:好的?|对|嗯)[，,！! ]+/,'');
  if(value.length>500||/[\n`<>?？]/.test(value)||/不要|不用|别|无需|不需要|不能|禁止|如何|怎么|是否|能否|可以吗|如果|示例|举例|(?:吗|么|呢)[。.!！]?$/.test(value))return false;
  const prefix='(?:请)?(?:帮我|麻烦)?',target='(?:这(?:个|条|次)|刚才(?:的|这(?:个|条))?|上一个|当前的?|本次的?)?',query='(?:查询(?:资产)?|SQL|问数结果)';
  const ending='(?:[。.!！ ]*|(?:为|成|到|作为).{1,100}|[，, ]*命名为.{1,100})$';
  return new RegExp(`^${prefix}(?:把|将)?${target}${query}[，, ]*(?:请)?(?:保存|收藏)(?:一下|下来)?${ending}`,'i').test(value)
    || new RegExp(`^${prefix}(?:保存|收藏|存下|记住)(?:一下)?${target}${query}${ending}`,'i').test(value);
}
export function querySchemaFingerprint(schema:DataObjectModelSchema,tableIds:string[]){
  const ids=new Set(tableIds);
  const resources=schema.resources.filter(t=>ids.has(t.id)).map(t=>({id:t.id,name:t.name,columns:t.columns.map(c=>({id:c.id,name:c.name,type:c.type,nullable:c.nullable,sensitive:c.sensitive===true,description:c.description,unit:c.unit,enumDescription:c.enumDescription}))}));
  if(resources.length!==ids.size)deny('查询依赖表已删除或不再可见，请重新查询。','QUERY_ASSET_SCHEMA_CHANGED');
  return createHash('sha256').update(JSON.stringify({resources,relations:schema.annotations.relations.filter(r=>ids.has(r.fromTableId)&&ids.has(r.toTableId))})).digest('hex');
}
export function createQueryAssets(store:KeyValueStore,gateway:AgentDataGateway){
  async function remember(owner:Owner,sessionId:string,input:Omit<Receipt,'id'|'createdAt'|'schemaFingerprint'>){
    const schema=await gateway.schema(input.sourceId,owner);
    const receipt:Receipt={...input,id:randomUUID(),createdAt:Date.now(),schemaFingerprint:querySchemaFingerprint(schema,input.tableIds)};
    if(receipt.definition.kind==='sql')receipt.definition={kind:'sql',operation:{...receipt.definition.operation,testParameters:{},parameters:receipt.definition.operation.parameters.map(({default:value,...p})=>({...p,required:value!==undefined||p.required}))}};
    if(Buffer.byteLength(JSON.stringify(receipt))>64000)deny('查询定义过大，无法生成收藏回执。');
    await withKeyLock(receiptKey(owner,sessionId),async()=>{const prior=await read<Receipt[]>(store,receiptKey(owner,sessionId),[]);await store.set(receiptKey(owner,sessionId),JSON.stringify([receipt,...prior.filter(r=>r.createdAt>Date.now()-7*86400000)].slice(0,5)));});
    return {receiptId:receipt.id,notice:'可在后续消息明确说“保存这个查询为 月度分析”；执行成功不代表业务口径已确认。'};
  }
  async function save(owner:Owner,sessionId:string,userText:string,raw:unknown,authorize:(sourceId:string,tableIds:string[])=>Promise<void>){
    if(!explicitQuerySave(userText))deny('仅在用户本轮明确要求时保存。请明确说“保存这个查询为 月度分析”；不会自动收藏。','QUERY_ASSET_EXPLICIT_SAVE_REQUIRED');
    const input=saveQueryAssetSchema.parse(raw);
    return withKeyLock(key(owner),async()=>{
      const receipts=await read<Receipt[]>(store,receiptKey(owner,sessionId),[]),receipt=input.receiptId?receipts.find(r=>r.id===input.receiptId):receipts[0];
      if(!receipt||receipt.createdAt<Date.now()-7*86400000)deny('当前会话没有有效的成功查询回执，请先执行查询。','QUERY_ASSET_RECEIPT_REQUIRED');
      const found=receipt!;await authorize(found.sourceId,found.tableIds);
      if(querySchemaFingerprint(await gateway.schema(found.sourceId,owner),found.tableIds)!==found.schemaFingerprint)deny('对象结构已变化，请重新查询后再保存。','QUERY_ASSET_SCHEMA_CHANGED');
      const assets=await read<QueryAsset[]>(store,key(owner),[]),prior=assets.find(a=>a.receiptId===found.id&&a.name===input.name);
      if(prior){await store.flush();return prior;}
      if(assets.length>=200)deny('最多保存200个查询资产，请先删除不再使用的查询。');
      const asset:QueryAsset={...found,id:randomUUID(),receiptId:found.id,name:input.name,businessNote:input.businessNote,version:1,status:'execution-verified',createdAt:Date.now()};
      await authorize(found.sourceId,found.tableIds);await store.set(key(owner),JSON.stringify([asset,...assets]));await store.flush();return asset;
    });
  }
  async function list(owner:Owner,raw:unknown,authorize?:(sourceId:string,tableIds:string[])=>Promise<void>){
    const input=listQueryAssetsSchema.parse(raw),assets=await read<QueryAsset[]>(store,key(owner),[]),visible=[];
    for(const asset of assets){if(input.sourceId&&asset.sourceId!==input.sourceId||!asset.name.toLowerCase().includes(input.search.toLowerCase()))continue;
      try{await gateway.schema(asset.sourceId,owner);await authorize?.(asset.sourceId,asset.tableIds);}catch{continue;}
      visible.push({id:asset.id,name:asset.name,question:asset.question,businessNote:asset.businessNote,sourceId:asset.sourceId,status:asset.status,createdAt:asset.createdAt,kind:asset.definition.kind,version:asset.version,parameters:asset.definition.kind==='sql'?asset.definition.operation.parameters:[]});
      if(visible.length===50)break;
    }return {assets:visible};
  }
  async function get(owner:Owner,id:string){const found=(await read<QueryAsset[]>(store,key(owner),[])).find(a=>a.id===id);if(!found)deny('查询资产不存在或无权访问。','QUERY_ASSET_NOT_FOUND');return found!;}
  async function prepare(owner:Owner,raw:unknown,authorize:(sourceId:string,tableIds:string[])=>Promise<void>){
    const input=runQueryAssetSchema.parse(raw),asset=await get(owner,input.assetId);await authorize(asset.sourceId,asset.tableIds);
    if(querySchemaFingerprint(await gateway.schema(asset.sourceId,owner),asset.tableIds)!==asset.schemaFingerprint)deny('Schema或字段说明已变化，请重新查询并保存新资产。','QUERY_ASSET_SCHEMA_CHANGED');
    if(asset.definition.kind==='structured'&&Object.keys(input.parameters).length)deny('该结构化资产保留原筛选值，不支持参数覆盖；请重新提问生成查询。');
    return {asset,parameters:input.parameters};
  }
  async function remove(owner:Owner,id:string){return withKeyLock(key(owner),async()=>{const asset=await get(owner,id);await store.set(key(owner),JSON.stringify((await read<QueryAsset[]>(store,key(owner),[])).filter(a=>a.id!==asset.id)));await store.flush();return {deleted:true};});}
  return {remember,save,list,prepare,remove};
}
