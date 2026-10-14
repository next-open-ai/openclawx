import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
import * as XLSX from 'xlsx';
import {readDocument} from '../document-service.js';
import {DocumentReadResultSchema} from '@workmate/contracts';
import {createSkillExecutionTools} from '../skill-runtime.js';
import {extractToolDetails} from '../pi-tools.js';
import {prepareAgentscopeHostTools} from '../agentscope/host-tools.js';
import {ingestKnowledge} from '../knowledge-runtime.js';

test('UD-T1: unified text, HTML, Word, slides and spreadsheet reading',async()=>{
  const fixtures:[string,Buffer,string][]=[
    ['notes.md',Buffer.from('重要的工作成果'),'重要的工作成果'],
    ['page.html',Buffer.from('<title>报告</title><script>doNotExecute()</script><main>经营结果</main>'),'经营结果'],
    ['report.docx',Buffer.from(zipSync({'word/document.xml':strToU8('<w:document><w:p><w:r><w:t>中文Word内容</w:t></w:r></w:p></w:document>')})),'中文Word内容'],
    ['slides.pptx',Buffer.from(zipSync({'ppt/slides/slide1.xml':strToU8('<a:p><a:r><a:t>中文幻灯片</a:t></a:r></a:p>')})),'中文幻灯片'],
    ['table.csv',Buffer.from('name,value\n上海,100\n'),'上海'],
  ];
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['name','value'],['三亚',200]]),'结果');
  fixtures.push(['table.xlsx',XLSX.write(book,{type:'buffer',bookType:'xlsx'}),'三亚']);
  for(const [fileName,bytes,expected] of fixtures){
    const result=DocumentReadResultSchema.parse(await readDocument({fileName,bytes}));assert.equal(result.ok,true,fileName);
    if(result.ok){assert.ok(result.text.includes(expected),fileName);assert.equal(result.info.parser,'builtin');assert.equal(result.info.nextAction,'none');assert.doesNotMatch(result.text,/doNotExecute/);}
  }
});

test('UD-T1: limits, cancellation, empty/bad/unsupported files are structured and actionable',async()=>{
  const short=await readDocument({fileName:'readme.txt',bytes:Buffer.from('hello world'),maxChars:5});assert.equal(short.ok,true);if(short.ok){assert.equal(short.text,'hello');assert.equal(short.info.truncated,true);}
  const cases:[string,Buffer,Record<string,unknown>,string][]=[['empty.txt',Buffer.alloc(0),{},'DOCUMENT_EMPTY'],['bad.pdf',Buffer.from('%PDF-1.4\nbad'),{},'DOCUMENT_PARSE_FAILED'],['legacy.doc',Buffer.from('old'),{},'DOCUMENT_UNSUPPORTED'],['huge.txt',Buffer.from('12345'),{maxBytes:3},'DOCUMENT_TOO_LARGE'],['cancel.txt',Buffer.from('text'),{signal:AbortSignal.abort()},'DOCUMENT_CANCELLED']];
  for(const [fileName,bytes,options,code] of cases){const result=await readDocument({fileName,bytes,...options});assert.equal(result.ok,false);if(!result.ok)assert.equal(result.code,code);}
  const pages=Buffer.from(zipSync({'ppt/slides/slide1.xml':strToU8('<a:p><a:t>第一页</a:t></a:p>'),'ppt/slides/slide2.xml':strToU8('<a:p><a:t>第二页</a:t></a:p>')}));
  const pageLimit=await readDocument({fileName:'two.pptx',bytes:pages,maxPages:1});assert.equal(pageLimit.ok,true);if(pageLimit.ok){assert.equal(pageLimit.info.pageCount,2);assert.equal(pageLimit.info.pagesRead,1);assert.equal(pageLimit.info.truncated,true);assert.doesNotMatch(pageLimit.text,/第二页/);}
  const rows=Array.from({length:150},(_,i)=>`row-${i},${i}`).join('\n');const preview=await readDocument({fileName:'rows.csv',bytes:Buffer.from(rows)});assert.equal(preview.ok,true);if(preview.ok){assert.equal(preview.info.truncated,true);assert.doesNotMatch(preview.text,/row-149/);}
});

test('UD-T4: ordinary/AgentScope tools read only the bounded workspace, including source documents',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'workmate-document-tool-'));
  try{
    await fs.mkdir(path.join(root,'.task','source'),{recursive:true});await fs.writeFile(path.join(root,'.task','source','notes.txt'),'原始文档内容');
    const tool=createSkillExecutionTools({runId:'document-tool-test',projectRoot:root,workspaceAccess:'read',skills:[]}).find(tool=>tool.name==='read_document')!;
    const read=DocumentReadResultSchema.parse(extractToolDetails(await tool.execute('read',{path:'.task/source/notes.txt'})));assert.equal(read.ok,true);if(read.ok)assert.equal(read.text,'原始文档内容');
    const denied=extractToolDetails(await tool.execute('escape',{path:'../private.txt'})) as {code:string};assert.equal(denied.code,'DOCUMENT_NOT_AVAILABLE');
    const invalid=extractToolDetails(await tool.execute('invalid',{path:'.task/source/notes.txt',maxChars:100000})) as {code:string};assert.equal(invalid.code,'DOCUMENT_INVALID_INPUT');
    const host=await prepareAgentscopeHostTools({runId:'document-host',projectWorkspacePath:root,mcpConnections:[]});
    try{assert.ok(host.runtimePatch.mcpTools?.some(tool=>tool.name==='read_document'));const result=await host.executeHostToolCalls('document-host',[{id:'host-read',name:'read_document',input:{path:'.task/source/notes.txt'}}]);assert.match(JSON.stringify(result),/原始文档内容/);}finally{await host.close();}
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('UD-T2: local knowledge import uses document service before its existing embedding configuration gate',async()=>{
  const kb={id:'document-ingest-test',name:'document test',provider:'lancedb' as const,enabled:true};
  await assert.rejects(ingestKnowledge({kb,title:'文档',fileName:'notes.md',fileBase64:Buffer.from('统一服务读取的知识内容').toString('base64')}),/Configure an embedding model/);
  await assert.rejects(ingestKnowledge({kb,title:'损坏文档',fileName:'broken.pdf',fileBase64:Buffer.from('%PDF-1.4\nbad').toString('base64')}),/文档内置解析未成功/);
});
