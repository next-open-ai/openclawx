/** Packaged HTML; no credentials, network access or same-origin privileges. */
export const inputHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; connect-src 'none'; base-uri 'none'">
<style>body{font:14px system-ui;color:#202738;margin:0;padding:20px;background:#fff}*{box-sizing:border-box}h2{margin:0 0 8px}p{color:#667085;line-height:1.6}input,button{font:inherit;border:1px solid #d8deea;border-radius:8px;padding:9px}input{width:100%;min-width:0}button{cursor:pointer;background:#f6f7fb}button:disabled{opacity:.5;cursor:wait}.bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.bar input{width:170px}table{width:100%;border-collapse:collapse;margin:18px 0}th{text-align:left;color:#667085;font-weight:500}td,th{padding:5px}th:first-child{width:35%}.primary{background:#4663e5;color:white;border:0}#error{color:#ba2636;min-height:20px}#notice{color:#247849}</style></head><body>
<h2>月度经营数据</h2><p>填写收入与成本，自动生成指标和明细报告。金额单位：人民币元；利润＝收入－成本。</p>
<form id="form"><div class="bar"><label for="period">统计月份</label><input id="period" type="month" required><button type="button" id="sample">填入示例数据</button></div>
<table><thead><tr><th>业务 / 区域</th><th>收入（元）</th><th>成本（元）</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<div class="bar"><button type="button" id="add">＋ 添加一行</button><span>最多 100 行</span></div>
<p id="error" role="alert"></p><p id="notice" role="status"></p><button id="save" class="primary" type="button">保存任务参数</button></form>
<script>
const rows=document.getElementById('rows'), form=document.getElementById('form'), save=document.getElementById('save');
let channel='', busy=false;
function changed(){if(channel)parent.postMessage({type:'openclawx.task.dirty',channel},'*')}
form.oninput=changed;
function add(row={name:'',revenue:'',cost:''}){
 if(rows.children.length>=100)return;
 const tr=document.createElement('tr');
 for(const key of ['name','revenue','cost']){
  const td=document.createElement('td'),input=document.createElement('input');input.dataset.key=key;input.required=true;
  input.setAttribute('aria-label',key==='name'?'业务名称':key==='revenue'?'收入':'成本');
  if(key==='name'){input.maxLength=100;}else{input.type='number';input.min='0';input.max='1000000000';input.step='0.01';}
  input.value=String(row[key]??'');td.append(input);tr.append(td);
 }
 const td=document.createElement('td'),button=document.createElement('button');button.type='button';button.textContent='删除';button.onclick=()=>{if(!busy){tr.remove();changed()}};td.append(button);tr.append(td);rows.append(tr);
}
function fill(data){rows.replaceChildren();document.getElementById('period').value=data.period||'';(data.rows?.length?data.rows:[{}]).forEach(add)}
document.getElementById('add').onclick=()=>{if(!busy){add();changed()}};
document.getElementById('sample').onclick=()=>{if(!busy){fill({period:document.getElementById('period').value||new Date().toISOString().slice(0,7),rows:[{name:'华东',revenue:120000,cost:80000},{name:'华南',revenue:90000,cost:65000}]});changed()}};
window.addEventListener('message',event=>{
 if(event.source!==parent)return;const message=event.data;
 if(message?.type==='openclawx.task.init'){channel=message.channel;save.textContent=message.submitLabel||'保存任务参数';fill(message.parameters||{});}
 if(message?.type==='openclawx.task.confirm'&&message.channel===channel&&channel){if(!form.reportValidity())parent.postMessage({type:'openclawx.task.confirm-error',channel,error:'请检查表单中的必填项和填写格式。'},'*');else save.click();}
 if(message?.type==='openclawx.task.saved'&&message.channel===channel){busy=false;save.disabled=false;document.getElementById('error').textContent=message.error||'';document.getElementById('notice').textContent=message.error?'':(message.notice||'参数已保存，可在页面上方立即运行。');}
});
form.onsubmit=event=>event.preventDefault();
form.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();save.click()}};
save.onclick=()=>{if(busy||!channel||!form.reportValidity())return;
 const data={period:document.getElementById('period').value,rows:[...rows.children].map(tr=>Object.fromEntries([...tr.querySelectorAll('input')].map(input=>[input.dataset.key,input.dataset.key==='name'?input.value:Number(input.value)])))};
 if(!data.rows.length){document.getElementById('error').textContent='请至少填写一行';return;}
 busy=true;save.disabled=true;document.getElementById('notice').textContent='';parent.postMessage({type:'openclawx.task.submit',channel,parameters:data},'*');
};
parent.postMessage({type:'openclawx.task.ready'},'*');
</script></body></html>`;
