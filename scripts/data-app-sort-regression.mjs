import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../apps/renderer/package.json', import.meta.url));
const ts = require('typescript');
const exports = {};
const code = readFileSync(new URL('../apps/renderer/src/features/data/workbench-presentation.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, URL });
const { sortDataApps, appModifiedAt, formatAppTime } = exports;
const delivered={id:'ready',name:'学生管理',appType:'自定义应用',createdAt:1,published:true,publishUrl:'http://127.0.0.1:47832/site',customSite:{bound:true,updatedAt:2}};
assert.equal(exports.galleryApps([delivered,{...delivered,id:'pending',delivery:{status:'awaiting-binding'}},{...delivered,id:'unpublished',published:false},{...delivered,id:'bad',publishUrl:'javascript:alert(1)'}]).length,1);
assert.equal(exports.galleryApps([delivered],'学生').length,1); assert.equal(exports.galleryApps([delivered],'missing').length,0);
assert.equal(exports.appAccessUrl({...delivered,lanUrl:'http://192.168.1.2:47832/site'},true),'http://192.168.1.2:47832/site');
assert.equal(exports.appAccessUrl(delivered,true),''); assert.equal(exports.appAccessUrl({...delivered,lanUrl:delivered.publishUrl},true),'');
const apps = [
  { id: 'old-updated', name: 'B', createdAt: 1000, customSite: { updatedAt: 9000 } },
  { id: 'new-draft', name: 'A', createdAt: 5000 },
  { id: 'same-b', name: 'C', createdAt: 2000, customSite: { updatedAt: 6000 } },
  { id: 'same-a', name: 'C', createdAt: 2000, customSite: { updatedAt: 6000 } },
];
const ids = list => Array.from(list, app => app.id);
assert.deepEqual(ids(sortDataApps(apps)), ['old-updated','same-a','same-b','new-draft']);
assert.deepEqual(ids(sortDataApps(apps, 'created')), ['new-draft','same-a','same-b','old-updated']);
assert.deepEqual(ids(sortDataApps(apps, 'name')), ['new-draft','old-updated','same-a','same-b']);
assert.deepEqual(ids(apps), ['old-updated','new-draft','same-b','same-a']);
assert.equal(appModifiedAt(apps[1]), 5000);
assert.equal(appModifiedAt({ createdAt: 1000, customSite: { updatedAt: NaN } }), 1000);
assert.equal(formatAppTime(undefined), '暂无记录');
assert.equal(formatAppTime(Infinity), '暂无记录');
assert.ok(!formatAppTime(1791856075035).includes('Invalid'));
assert.equal(sortDataApps([]).length, 0);
const page = readFileSync(new URL('../apps/renderer/src/features/data/DataWorkbenchPage.vue', import.meta.url), 'utf8');
assert.match(page, /v-for="app in sortedApps"/);
assert.match(page, /v-model="appSort"/);
assert.match(page, /页面修改：/);
assert.match(page, /如何创建支持修改的应用/);
assert.ok(!page.includes('>继续优化</button>'));
const sidebar=readFileSync(new URL('../apps/renderer/src/app/AppSidebar.vue',import.meta.url),'utf8');
const shell=readFileSync(new URL('../apps/renderer/src/app/App.vue',import.meta.url),'utf8');
assert.match(sidebar,/data-app-gallery-entry/); assert.match(sidebar,/emit\('openApplications'\)/);
assert.match(shell,/@open-applications="galleryOpen = true"/);
assert.match(shell,/<ApplicationGallery v-if="galleryOpen" @close="galleryOpen = false"/);
assert.match(shell,/watch\(user,.*galleryOpen.value=false/);
console.log('MDA-T16 PASS: update/creation/name sorting, stable ties, invalid timestamp fallback, non-mutating and page wiring.');
console.log('MDA-T21 PASS: gallery availability/URL safety, brand entry, full-screen overlay wiring, user change reset and redundant action removal.');
