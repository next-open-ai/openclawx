// Optional browser regression: requires Playwright and an installed browser. Uses isolated data.
const {chromium}=require(process.env.OPENCLAWX_PLAYWRIGHT_MODULE || 'playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const {once}=require('node:events');const assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'openclawx-task-ui-')),port=await (await import('./lib/web-launcher.mjs')).choosePort(4467),base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['apps/api/dist/main.cjs'],{cwd:root,env:{...process.env,OPENCLAWX_DATA_DIR:dir,OPENCLAWX_API_PORT:String(port),OPENCLAWX_AGENT_ENGINE:'pi',OPENCLAWX_AGENTSCOPE_ENABLED:'0',OPENCLAWX_WEB_STATIC_DIR:path.join(root,'apps/renderer/dist')},stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);let browser;
try{
for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
const response=await fetch(base+'/api/auth/bootstrap',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'ui-check',displayName:'界面验收',password:'ui-check-temporary-password'})});assert.equal(response.status,200);const {token}=await response.json();
browser=await chromium.launch({headless:true,...(process.env.OPENCLAWX_BROWSER_CHANNEL ? {channel:process.env.OPENCLAWX_BROWSER_CHANNEL} : {})});const page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(10000);const errors=[];page.on('console',m=>{if(m.type()==='error')console.log('browser:',m.text())});page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(token=>{if(window===window.top)localStorage.setItem('auth.session.token',token)},token);await page.goto(base);await page.getByRole('button',{name:'以后再说',exact:true}).click();await page.getByRole('button',{name:'自动化与任务',exact:true}).click();
await page.getByRole('button',{name:/使用模板创建/}).click();
let frame=page.frameLocator('iframe[title="任务参数交互模板"]');await frame.getByRole('button',{name:'填入示例数据'}).click();await frame.getByRole('button',{name:'保存任务参数'}).click();
await page.getByRole('button',{name:'立即运行',exact:true}).click();await page.getByRole('button',{name:'正在查看',exact:true}).waitFor();
let report=page.frameLocator('iframe[title="经营数据汇总报告"]');await report.getByText('210,000.00',{exact:true}).waitFor();await report.getByText('65,000.00',{exact:true}).first().waitFor();
await page.locator('iframe[title="经营数据汇总报告"]').scrollIntoViewIfNeeded();await page.waitForTimeout(300);await page.screenshot({path:path.join(os.tmpdir(),'openclawx-task-report.png'),fullPage:true});
await page.getByRole('button',{name:'修改参数',exact:true}).click();frame=page.frameLocator('iframe[title="任务参数交互模板"]');await frame.getByLabel('收入',{exact:true}).first().fill('150000');await frame.getByRole('button',{name:'保存任务参数'}).click();await page.getByRole('button',{name:'立即运行',exact:true}).click();
report=page.frameLocator('iframe[title="经营数据汇总报告"]');await report.getByText('240,000.00',{exact:true}).waitFor();
await page.getByRole('button',{name:'查看结果',exact:true}).click();await report.getByText('210,000.00',{exact:true}).waitFor();
await page.reload();await page.getByRole('button',{name:'自动化与任务',exact:true}).click();await page.getByRole('button',{name:/参数 v2.*查看任务/}).click();
await page.frameLocator('iframe[title="经营数据汇总报告"]').getByText('240,000.00',{exact:true}).waitFor();
// Configure and publish a real template through the editor.
await page.getByRole('button',{name:'模板配置',exact:true}).click();
await page.getByRole('button',{name:'＋ 新建模板',exact:true}).click();
await page.getByLabel('模板名称',{exact:true}).fill('华东月度经营模板');
await page.getByLabel('模板说明',{exact:true}).fill('浏览器验收：绿色报告与默认数据');
await page.getByRole('button',{name:'2. 输入参数',exact:true}).click();
const defaults=page.frameLocator('iframe[title="模板默认参数"]');
await defaults.getByRole('button',{name:'填入示例数据'}).click();
await defaults.getByRole('button',{name:'应用为默认参数'}).click();
await page.getByRole('button',{name:'4. 结果与展示',exact:true}).click();
await page.getByLabel('报告标题',{exact:true}).fill('华东经营月报');
await page.getByLabel('主题色',{exact:true}).selectOption('green');
await page.getByLabel('显示业务明细',{exact:true}).uncheck();
await page.getByRole('button',{name:'5. 试运行与发布',exact:true}).click();
assert.equal(await page.getByRole('button',{name:'发布模板',exact:true}).isEnabled(),false);
await page.getByRole('button',{name:'保存并试运行',exact:true}).click();
await page.frameLocator('iframe[title="模板报告预览"]').getByRole('heading',{name:/华东经营月报/}).waitFor();
await page.getByRole('button',{name:'发布模板',exact:true}).click();
await page.getByRole('button',{name:'当前版本已发布',exact:true}).waitFor();
await page.locator('iframe[title="模板报告预览"]').scrollIntoViewIfNeeded();
await page.waitForTimeout(300);await page.screenshot({path:path.join(os.tmpdir(),'openclawx-template-configuration.png'),fullPage:true});
await page.getByRole('button',{name:'模板任务',exact:true}).click();
await page.getByRole('button',{name:/华东月度经营模板.*使用模板创建/}).click();
frame=page.frameLocator('iframe[title="任务参数交互模板"]');
await frame.getByLabel('收入',{exact:true}).first().waitFor();
assert.equal(await frame.getByLabel('收入',{exact:true}).first().inputValue(),'120000');
await frame.getByRole('button',{name:'保存任务参数'}).click();
await page.getByRole('button',{name:'立即运行',exact:true}).click();
report=page.frameLocator('iframe[title="经营数据汇总报告"]');
await report.getByRole('heading',{name:/华东经营月报/}).waitFor();
assert.equal(await report.getByRole('heading',{name:'业务明细',exact:true}).count(),0);
const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'下载 CSV',exact:true}).click();
const download=await downloadPromise;assert.ok(download.suggestedFilename().endsWith('.csv'));
await page.reload();await page.getByRole('button',{name:'自动化与任务',exact:true}).click();
await page.getByRole('button',{name:'模板配置',exact:true}).click();
await page.getByRole('button',{name:'配置模板',exact:true}).click();
assert.equal(await page.getByLabel('模板名称',{exact:true}).inputValue(),'华东月度经营模板');
await page.getByRole('button',{name:'数据工作台',exact:true}).click();
await page.getByRole('button',{name:'数据任务闭环体验',exact:true}).click();
await page.getByRole('button',{name:'准备测试数据并开始',exact:true}).click();
await page.getByLabel('搜索客户',{exact:true}).fill('华东');
await page.getByRole('button',{name:'查询可选客户',exact:true}).click();
await page.locator('select').first().selectOption('C001');
await page.getByRole('button',{name:'运行分析并保存结果',exact:true}).click();
await page.frameLocator('iframe[title="数据库经营分析报告"]').getByText('50,000.00',{exact:true}).waitFor();
await page.screenshot({path:path.join(os.tmpdir(),'openclawx-database-task-loop.png'),fullPage:true});
await page.getByRole('button',{name:'← 返回数据工作台',exact:true}).click();
await page.getByText(/测试结果 · 数据库经营分析/).first().waitFor();
console.log('PASS browser: workbench entry, seed, database-backed customer search, calculation, report and saved dataset');
assert.deepEqual(errors,[]);console.log('PASS browser: template configuration, trial/publish, defaults, customized report/export and existing task regression; screenshot:',path.join(os.tmpdir(),'openclawx-task-report.png'));
}catch(e){console.error(e);if(browser){const pages=browser.contexts().flatMap(c=>c.pages());if(pages[0]){console.error((await pages[0].locator('body').innerText()).slice(-6000));await pages[0].screenshot({path:path.join(os.tmpdir(),'openclawx-task-ui-error.png'),fullPage:true});}}process.exitCode=1;}
finally{await browser?.close();if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}await fs.rm(dir,{recursive:true,force:true});}
})();
