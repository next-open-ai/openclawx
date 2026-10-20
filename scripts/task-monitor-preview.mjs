// Isolated visual fixture for the production TaskRunMonitor; no user APIs or model calls.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
const vueRequire=createRequire(fs.realpathSync('apps/renderer/node_modules/vue/package.json'));
const viteRequire=createRequire(fs.realpathSync('apps/renderer/node_modules/vite/package.json'));
const {parse,compileScript,compileStyle}=vueRequire('@vue/compiler-sfc'),{build}=viteRequire('esbuild');
let css='';
const fixture=`
const state=new URLSearchParams(location.search).get('state')||'running';
const startedAt=Date.now()-47000;
const steps=[{stage:'input',status:'completed',at:startedAt+200}];
if(state==='completed')steps.push({stage:'execution',status:'completed',at:Date.now()-2000},{stage:'output',status:'completed',at:Date.now()-1000});
const run={id:'demo-run-2026',taskId:'demo-task',status:state==='completed'?'completed':state==='failed'?'failed':'running',agentStatus:state==='approval'?'waiting-approval':'running',startedAt,finishedAt:state==='completed'||state==='failed'?Date.now()-1000:undefined,steps,agentRunId:'demo-agent',sessionId:'demo-session',error:state==='failed'?'演示：数据源连接失败，请检查网络后重新运行。':undefined,result:state==='completed'?{id:'demo-result'}:undefined};
run.jsonResult={kind:'json-result',schemaVersion:'1.0',taskId:'demo-task',runId:'demo-run-2026',status:run.status,input:{parameters:{topic:'AI新闻',count:10},employeeId:'general',prompt:'隔离演示任务'},data:{summary:'本次演示报告内容',items:10},error:run.error??null,startedAt};
export const templateTasksApi={detail:async()=>{if(state==='offline')throw Error('fixture offline');return{runs:[run]};},result:async()=>({result:{id:'demo-result'},html:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font:16px/1.8 system-ui;color:#173047;padding:28px}h1{font-size:26px;color:#215c6c}</style><h1>本次运行报告 · 隔离演示</h1><p>这份报告属于 demo-run-2026，不是其他运行的结果。</p><p>已整理10条新闻摘要。此处仅为界面验证样例，没有调用真实模型。</p></html>'})};
export const getRunRecord=async()=>({id:'demo-agent',status:state==='approval'?'waiting-approval':state==='completed'?'completed':state==='failed'?'failed':'running',activities:[
 {toolName:'search',summary:'演示：按用户指定主题检索新闻来源。',status:'completed',at:startedAt+1500},
 {toolName:'read_document',summary:'演示：读取已授权来源，提取标题、摘要与发布时间。',status:'completed',at:startedAt+11000},
 {toolName:'write_artifact',summary:'演示：正在整理新闻摘要和来源链接。',status:state==='completed'?'completed':'running',at:startedAt+35000},
],transcript:state==='completed'?'演示任务已完成，报告已保存在任务运行记录中。':'',usage:{totalTokens:4850}});
`;
const file=path.resolve('apps/renderer/src/features/automations/TaskRunMonitor.vue');
const bundle=await build({bundle:true,write:false,platform:'browser',format:'esm',stdin:{contents:`import {createApp,h,ref} from 'vue';import Monitor from '${file}';createApp({setup(){const visible=ref(true);return()=>visible.value?h(Monitor,{taskId:'demo-task',runId:'demo-run-2026',taskName:'AI新闻自动化 · 隔离演示',onClose:()=>visible.value=false}):h('p','监控已关闭，演示任务未取消。');}}).mount('#app');`,loader:'ts',resolveDir:path.resolve('apps/renderer')},define:{'process.env.NODE_ENV':'"development"',__VUE_OPTIONS_API__:'true',__VUE_PROD_DEVTOOLS__:'false',__VUE_PROD_HYDRATION_MISMATCH_DETAILS__:'false'},plugins:[{name:'monitor-fixture',setup(builder){
 builder.onResolve({filter:/^vue$/},()=>({path:vueRequire.resolve('vue/dist/vue.esm-bundler.js')}));
 builder.onResolve({filter:/\/template-tasks$|\/orchestration$/},()=>({path:'fixture',namespace:'isolated'}));
 builder.onLoad({filter:/.*/,namespace:'isolated'},()=>({contents:fixture,loader:'ts'}));
 builder.onLoad({filter:/\.vue$/},({path:file})=>{const{descriptor}=parse(fs.readFileSync(file,'utf8'));for(const style of descriptor.styles)css+=compileStyle({source:style.content,id:'monitor-preview',scoped:false}).code;return{contents:compileScript(descriptor,{id:'monitor-preview',inlineTemplate:true}).content,loader:'ts'};});
}}]});
const server=createServer((req,res)=>{
 if(req.url?.startsWith('/bundle.js')){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text);}
 res.setHeader('content-type','text/html');
 res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Task monitor isolated preview</title><style>*{box-sizing:border-box}body{margin:0;background:#090f1c;color:white;font-family:system-ui}${css}</style><div id="app"></div><script type="module" src="/bundle.js"></script></html>`);
});
server.listen(0,'127.0.0.1',()=>console.log('MONITOR_PREVIEW http://127.0.0.1:'+server.address().port));
