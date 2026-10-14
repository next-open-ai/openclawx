import {WorkLookupResultSchema} from '@workmate/contracts';
export function parseWorkLookupEvent(message:Record<string,unknown>){
  if(message.name!=='search_work_results'&&message.name!=='read_work_result')return null;
  const parsed=WorkLookupResultSchema.safeParse(message.result);
  return parsed.success?{items:parsed.data.items||[],summary:parsed.data.spokenSummary,error:parsed.data.ok?'':parsed.data.spokenSummary,taskId:parsed.data.taskId}:{items:[],summary:'',error:'成果查询返回格式不正确，请重试；这不代表成果不存在。',taskId:undefined};
}
