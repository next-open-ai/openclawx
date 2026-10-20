// Exercise the production bundled SDK without network, credentials or user state.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parameterUiHtml} from '../packages/orchestrator/dist/task-parameter-ui.js';
const html=parameterUiHtml({version:1,projectId:'p',revision:'r',files:{'index.html':'<html><head></head><body><script>platform.submit({})</script></body></html>','input.schema.json':'{"type":"object","properties":{}}'}});
const sdk=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const listeners=[],messages=[];let clicks=0,valid=true;
const parent={postMessage:m=>messages.push(m)};
let submits=0;
const target={disabled:false,textContent:'确认验证',type:'button',form:{reportValidity:()=>valid,dispatchEvent:event=>{assert.equal(event.type,'submit');assert.equal(event.cancelable,true);submits++;}},click:()=>clicks++};
let buttons=[target];
vm.runInNewContext(sdk,{parent,window:{addEventListener:(_type,handler)=>listeners.push(handler),dispatchEvent(){}},document:{addEventListener(){},querySelectorAll:()=>buttons,getElementById:()=>({textContent:''})},SubmitEvent:class {constructor(type,options){this.type=type;Object.assign(this,options);}},CustomEvent:class {},structuredClone,crypto:{randomUUID:()=> 'id'},setTimeout,clearTimeout});
function send(source,data){for(const handler of listeners)handler({source,data});}
send(parent,{type:'openclawx.task.init',channel:'current',submitLabel:'确认验证'});
send({}, {type:'openclawx.task.confirm',channel:'current'});
send(parent,{type:'openclawx.task.confirm',channel:'stale'});assert.equal(clicks,0);
send(parent,{type:'openclawx.task.confirm',channel:'current'});assert.equal(clicks,1);
valid=false;send(parent,{type:'openclawx.task.confirm',channel:'current'});assert.equal(clicks,1);assert.match(messages.at(-1).error,/必填项/);
valid=true;buttons=[target,target];send(parent,{type:'openclawx.task.confirm',channel:'current'});assert.equal(clicks,1);assert.match(messages.at(-1).error,/唯一/);
buttons=[{...target,textContent:'其他',type:'submit'}];send(parent,{type:'openclawx.task.confirm',channel:'current'});assert.equal(clicks,1);assert.equal(submits,1,'native submit handler runs without browser form navigation');
console.log('TP-T14 PASS: SDK source/channel isolation, native validity, exact label/unique form submission and ambiguous-button error.');
