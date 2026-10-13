import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

async function writeAtomic(file:string,content:string){
  const temporary=`${file}.${randomUUID()}.tmp`;
  try{
    await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
    await fs.writeFile(temporary,content,{mode:0o600});
    await fs.rename(temporary,file);
  }catch(error){
    await fs.unlink(temporary).catch(()=>{});
    throw error;
  }
}

/** Best-effort replicas only. The SQLite save never waits for this queue. */
export class ExperienceFileMirror {
  private pending=new Map<string,string>();
  private active=false;
  private idle:Array<()=>void>=[];
  constructor(
    private write:(file:string,content:string)=>Promise<void>=writeAtomic,
    private warn:(state:'failed'|'skipped')=>void=state=>console.warn(`[experience] JSON mirror ${state}; SQLite remains authoritative.`),
    private capacity=64,
  ){}
  enqueue(file:string,content:string):'queued'|'skipped'{
    if(!this.pending.has(file)&&this.pending.size>=this.capacity){this.warn('skipped');return 'skipped';}
    this.pending.set(file,content);
    if(!this.active){this.active=true;setImmediate(()=>{void this.drain();});}
    return 'queued';
  }
  private async drain(){
    while(this.pending.size){
      const [file,content]=this.pending.entries().next().value!;
      this.pending.delete(file);
      try{await this.write(file,content);}catch{this.warn('failed');}
    }
    this.active=false;
    this.idle.splice(0).forEach(resolve=>resolve());
  }
  /** Explicit drain for controlled tests; never used on the agent request path. */
  async flush(){if(this.active)await new Promise<void>(resolve=>this.idle.push(resolve));}
}

export const experienceFileMirror=new ExperienceFileMirror();
