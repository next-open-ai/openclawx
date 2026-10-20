// WC-T8: actual App navigation handlers, isolated refs/storage; no user state or execution.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(fs.realpathSync('apps/renderer/node_modules/vite/package.json'));
const { transform } = require('esbuild');
const app = fs.readFileSync('apps/renderer/src/app/App.vue','utf8');
const page = fs.readFileSync('apps/renderer/src/features/projects/ProjectsPage.vue','utf8');
const workspace = fs.readFileSync('apps/renderer/src/features/projects/ProjectConversationWorkspace.vue','utf8');
assert.match(app, /<ChatWorkspace[^\n]*@open-project="openProjectFromChat"/);
assert.match(app, /<ProjectsPage[^\n]*:return-to-chat-project-id="projectChatOrigin\?\.projectId"[^\n]*@return-to-chat="returnToProjectChat"/);
assert.match(page, /:back-label="workflowDetailTrail.length \? '返回来源项目' : selected.id === returnToDataProjectId \? '返回数据对象' : selected.id === returnToTemplateProjectId \? '返回任务中心' : selected.id === returnToChatProjectId \? '返回对话工作台' : undefined"/);
assert.match(page, /@back="backFromWorkflowProject"/);
assert.match(workspace, /← \{\{ backLabel \|\| '项目列表' \}\}/);
const helperSource=fs.readFileSync('apps/renderer/src/app/project-chat-navigation.ts','utf8').replace('export interface','interface').replace('export function','function');
const handlers=app.slice(app.indexOf('const projectChatOrigin ='),app.indexOf('onMounted(async () =>',app.indexOf('const projectChatOrigin =')));
const templateHelperSource=fs.readFileSync('apps/renderer/src/app/project-template-navigation.ts','utf8').replace('export interface','interface').replace('export function','function');
const compiled=await transform(helperSource+'\n'+templateHelperSource+'\n'+handlers,{loader:'ts',target:'es2022'});
const watchers=[];const ref=value=>({value});
const user=ref({id:'u1'}),view=ref('chat'),active=ref({id:'chat-a'}),conversations=ref([{id:'chat-a'},{id:'chat-b'}]);
const writes=[],selected=[];
const watch=(source,callback)=>watchers.push({source,callback});
const setView=next=>{const previous=view.value;view.value=next;for(const w of watchers)if(w.source===view)w.callback(next,previous);};
const api=new Function('ref','watch','user','view','activeConversation','conversations','writeStored','setView','selectConversation','dataNavigationScope',compiled.code+';return {projectChatOrigin,openProjectFromChat,openProjectFromAssets,returnToProjectChat,projectChatReturnTarget,projectTemplateOrigin,returnDefinitionId,openProjectFromTemplate,returnToProjectTemplate};')(ref,watch,user,view,active,conversations,async(k,v)=>writes.push([k,v]),setView,id=>selected.push(id),ref('test-scope'));
await api.openProjectFromChat('run-a');assert.equal(view.value,'projects');
assert.deepEqual(api.projectChatOrigin.value,{projectId:'run-a',conversationId:'chat-a',userId:'u1'});
active.value={id:'chat-b'};api.returnToProjectChat();assert.equal(view.value,'chat');assert.deepEqual(selected,['chat-a']);assert.equal(api.projectChatOrigin.value,null);
active.value={id:'chat-a'};await api.openProjectFromChat('run-a');
assert.equal(api.projectChatReturnTarget(api.projectChatOrigin.value,'other-project','u1',conversations.value),null);
assert.equal(api.projectChatReturnTarget(api.projectChatOrigin.value,'run-a','other-user',conversations.value),null);
conversations.value=[{id:'chat-b'}];api.returnToProjectChat();assert.deepEqual(selected,['chat-a']);assert.equal(view.value,'chat');
conversations.value=[{id:'chat-a'}];await api.openProjectFromChat('run-a');await api.openProjectFromAssets('run-a');assert.equal(api.projectChatOrigin.value,null);
setView('chat');await api.openProjectFromChat('run-a');setView('assets');assert.equal(api.projectChatOrigin.value,null);
setView('chat');await api.openProjectFromChat('run-a');user.value={id:'u2'};for(const w of watchers)if(typeof w.source==='function')w.callback('u2','u1');assert.equal(api.projectChatOrigin.value,null);
assert.ok(writes.every(([key])=>key==='projects.focus-id'),'origin must not persist');
console.log('WC-T8 PASS: actual navigation handlers, original chat return, non-chat origin, deleted chat, project/user isolation, leave/logout cleanup; component wiring and default project-list label.');

// TP-T7: template origin is exact, ephemeral and isolated from chat/generic navigation.
setView('automations');await api.openProjectFromTemplate('parameter-p','template-a');
assert.equal(view.value,'projects');assert.equal(api.projectChatOrigin.value,null);
api.returnToProjectTemplate('unrelated');assert.equal(view.value,'projects');
api.returnToProjectTemplate('parameter-p');assert.equal(view.value,'automations');
assert.equal(api.returnDefinitionId.value,'template-a');assert.equal(api.projectTemplateOrigin.value,null);
await api.openProjectFromTemplate('parameter-p','template-b');assert.equal(api.returnDefinitionId.value,undefined);
user.value={id:'u3'};api.returnToProjectTemplate('parameter-p');assert.equal(view.value,'projects');
for(const w of watchers)if(typeof w.source==='function')w.callback('u3','u2');
assert.equal(api.projectTemplateOrigin.value,null);assert.equal(api.returnDefinitionId.value,undefined);
setView('automations');await api.openProjectFromTemplate('parameter-p','template-c');
await api.openProjectFromAssets('parameter-p');assert.equal(api.projectTemplateOrigin.value,null);
setView('automations');await api.openProjectFromTemplate('parameter-p','template-c');
setView('assets');assert.equal(api.projectTemplateOrigin.value,null);
assert.match(app, /@open-project="openProjectFromTemplate"/);
assert.match(app, /@return-to-template="returnToProjectTemplate"/);
console.log('TP-T7 PASS: exact template return, unrelated project ignored, user switch, generic entry and leave cleanup; no persisted origin.');

// WP-T4: execute production project navigation handlers; sync selection watch matches Vue.
const navigation=page.slice(page.indexOf('const workflowDetailTrail ='),page.indexOf('const visibilityFilter ='));
const navCompiled=await transform(navigation,{loader:'ts',target:'es2022'});
const navWatchers=[];let selection='parent';
const selectionRef={get value(){return selection;},set value(id){selection=id;for(const callback of navWatchers)callback(id);}};
const projectList=ref([{id:'parent',status:'draft'}]),navError=ref(''),events=[],reads=[],tracked=[],refreshed=[];
const selectedProject={get value(){return projectList.value.find(p=>p.id===selection);}};
let resolvePending;let deferred=false;
const nav=new Function('ref','watch','selectedId','orch','error','projects','adoptServerProject','trackManagedProject','refreshManaged','selected','props','emit',navCompiled.code+';return {openWorkflowProject,backFromWorkflowProject,workflowDetailTrail};')(
  ref,(_source,callback)=>navWatchers.push(callback),selectionRef,
  {getProject:async id=>{reads.push(id);if(id==='denied')throw Error('forbidden');if(id==='missing')return null;if(deferred){deferred=false;await new Promise(r=>resolvePending=r);}return {id,status:'running'};}},
  navError,projectList,server=>({...server,managedServer:true}),id=>tracked.push(id),async id=>refreshed.push(id),selectedProject,
  {returnToChatProjectId:'parent'},event=>events.push(event));
await nav.openWorkflowProject('child');assert.equal(selection,'child');assert.equal(projectList.value.length,2);assert.deepEqual(nav.workflowDetailTrail.value,['parent']);
await nav.openWorkflowProject('grandchild');assert.equal(selection,'grandchild');
nav.backFromWorkflowProject();assert.equal(selection,'child');nav.backFromWorkflowProject();assert.equal(selection,'parent');
assert.equal(projectList.value[0].status,'draft');assert.deepEqual(refreshed,['child','grandchild']);
nav.backFromWorkflowProject();assert.deepEqual(events,['returnToChat']);
await nav.openWorkflowProject('denied');assert.equal(selection,'parent');assert.match(navError.value,/来源项目已保留/);
await nav.openWorkflowProject('missing');assert.equal(selection,'parent');
await nav.openWorkflowProject('child');selectionRef.value='unrelated';assert.deepEqual(nav.workflowDetailTrail.value,[]);nav.backFromWorkflowProject();assert.equal(selection,null);
selectionRef.value='parent';deferred=true;const pending=nav.openWorkflowProject('late');selectionRef.value='child';resolvePending();await pending;assert.equal(selection,'child');assert.ok(!projectList.value.some(p=>p.id==='late'));
selectionRef.value='parent';await nav.openWorkflowProject('child');projectList.value=projectList.value.filter(p=>p.id!=='parent');nav.backFromWorkflowProject();assert.equal(selection,null);
assert.deepEqual(tracked,['child','grandchild','child','child']);
console.log('WP-T4 PASS: independent child adoption, source/nested return, chat-origin return, denied/missing child, stale selection and missing parent; navigation never confirms/replans or executes source draft.');
