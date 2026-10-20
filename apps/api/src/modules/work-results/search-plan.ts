import type {WorkResultSearchInput,WorkResultItem} from '@workmate/contracts';

const DAY=86_400_000,SHANGHAI_OFFSET=8*60*60*1000;

/** Metadata predicates are deterministic; the model only ranks the remaining topic. */
export function workResultSearchPlan(input:WorkResultSearchInput,now=Date.now()){
  const query=input.query.normalize('NFKC');
  const created=input.created??(/今天|今日/.test(query)?'today':/昨天|昨日/.test(query)?'yesterday':/最近|近期|最新/.test(query)?'recent':undefined);
  const fileType=input.fileType??(/\bpdf\b/i.test(query)?'pdf':/文件|文档/.test(query)?'file':undefined);
  const metadata=Boolean(created||fileType);
  const topic=metadata?query
    .replace(/今天|今日|昨天|昨日|最近|近期|最新|\bpdf\b/gi,' ')
    .replace(/当前对话|本次对话|这个对话|历史记录|历史成果|所有对话/g,' ')
    .replace(/帮我|请帮忙|请|找一下|查一下|看一下|找找|查找|查询|看看|一下|列出|显示|有哪些|有没有|这个|那个|这份|那份/g,' ')
    .replace(/写的|写过的|生成的|创建的|制作的|保存的|生成|创建|制作|保存|工作成果|成果|文档|文件|的/g,' ')
    .replace(/^\s*(?:我|找)(?=\s|$)/,' ')
    .replace(/[，。？！?！、\s]+/g,' ').trim():input.query;
  const scope=created&&!/当前对话|本次对话|这个对话/.test(query)?'history':input.scope;
  const dayStart=Math.floor((now+SHANGHAI_OFFSET)/DAY)*DAY-SHANGHAI_OFFSET;
  const start=created==='today'?dayStart:created==='yesterday'?dayStart-DAY:undefined;
  const end=start===undefined?undefined:start+DAY;
  const accepts=(item:WorkResultItem)=>{
    if(fileType&&item.kind!=='asset')return false;
    if(fileType==='pdf'&&item.mimeType?.split(';')[0].trim().toLowerCase()!=='application/pdf'&&!/\.pdf$/i.test(item.name))return false;
    return start===undefined||(item.createdAt>=start&&item.createdAt<end!);
  };
  return{topic,scope,created,fileType,metadata,accepts};
}
