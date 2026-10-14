/** Small deterministic filename matcher; no model call or document-body index. */
function normalize(value:string):string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/([一二三四五六七八九十])天/g,(_,n:string)=>`${'一二三四五六七八九十'.indexOf(n)+1}天`)
    .replace(/帮我|请帮忙|请|找一下|查一下|查找|查询|以前|之前|刚才|生成的|保存的|那个|这个|这份|那份|文件|报告文件/g,'')
    .replace(/[到至往]/g,'').replace(/的/g,'').replace(/旅行|旅游/g,'旅游')
    .replace(/[^\p{L}\p{N}]+/gu,'');
}

export function matchesWorkResult(query:string,value:string):boolean {
  if(!query.trim())return true;
  if(value.toLowerCase().includes(query.toLowerCase()))return true;
  const wanted=normalize(query),candidate=normalize(value);
  // Never turn a nonempty but uninformative request into an all-history match.
  if(!wanted)return false;
  if(candidate.includes(wanted))return true;
  const words=query.split(/[\s,，、]+/u).map(normalize).filter(Boolean).flatMap(part=>part.match(/[a-z0-9]+|[\p{Script=Han}]+/gu)||[]);
  return words.every(word=>{
    if(candidate.includes(word))return true;
    if(!/^[\p{Script=Han}]+$/u.test(word)||word.length<4)return false;
    const pairs=Array.from({length:word.length-1},(_,i)=>word.slice(i,i+2));
    // Permit wording differences, but require most meaningful Chinese pairs.
    return pairs.filter(pair=>candidate.includes(pair)).length>=Math.max(2,Math.ceil(pairs.length*0.7));
  });
}
