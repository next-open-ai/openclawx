import type {TaskSchedule} from '@openclawx/contracts';

/** Next occurrence strictly after from; calendar time belongs to the configured zone. */
export function nextTaskSchedule(schedule:TaskSchedule,from:number):number|null {
  if(schedule.kind==='manual'||!schedule.enabled)return null;
  if(schedule.kind==='once')return schedule.at;
  if(schedule.kind==='interval')return from+schedule.everyMinutes*60_000;
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:schedule.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  function parts(epoch:number){return Object.fromEntries(formatter.formatToParts(epoch).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));}
  const current=parts(from),[hour,minute]=schedule.time.split(':').map(Number);
  const firstDay=Date.UTC(current.year,current.month-1,current.day);
  for(let offset=0;offset<=370;offset++) {
    const day=new Date(firstDay+offset*86_400_000);
    if(schedule.kind==='weekly'&&!schedule.weekdays.includes(day.getUTCDay()))continue;
    if(schedule.kind==='monthly'&&day.getUTCDate()!==Math.min(schedule.dayOfMonth,new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth()+1,0)).getUTCDate()))continue;
    const wall=Date.UTC(day.getUTCFullYear(),day.getUTCMonth(),day.getUTCDate(),hour,minute);
    let candidate=wall;
    for(let n=0;n<4;n++){const p=parts(candidate);const difference=wall-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);candidate+=difference;if(!difference)break;}
    const actual=parts(candidate);
    // Skip nonexistent DST times rather than silently shifting the user's time.
    if(actual.year===day.getUTCFullYear()&&actual.month===day.getUTCMonth()+1&&actual.day===day.getUTCDate()&&actual.hour===hour&&actual.minute===minute&&candidate>from)return candidate;
  }
  throw new Error('无法计算下次任务时间，请检查周期配置');
}
