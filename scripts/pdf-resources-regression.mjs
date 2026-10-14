import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const entry=path.resolve(process.argv[2]||'apps/api/dist/main.cjs');
const require=createRequire(entry),resources=path.dirname(require.resolve('pdfjs-dist/package.json'));
for(const name of ['cmaps/UniGB-UCS2-H.bcmap','cmaps/Adobe-GB1-UCS2.bcmap','standard_fonts/LICENSE_FOXIT','LICENSE'])assert.ok(fs.existsSync(path.join(resources,name)),name);
if(process.argv[2])assert.equal(fs.existsSync(path.join(resources,'build')),false,'do not ship a second PDF renderer');
const {getDocumentProxy}=require('unpdf');
const text='上海三亚中文解析',hex=Array.from(text).map(c=>c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
const stream=`BT /F1 12 Tf 40 700 Td <${hex}> Tj ET`;
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 0 >> /DW 1000 >>'];
let bytes='%PDF-1.4\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(bytes.length);bytes+=`${i+1} 0 obj\n${o}\nendobj\n`;});const xref=bytes.length;
bytes+=`xref\n0 7\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const pdf=await getDocumentProxy(new Uint8Array(Buffer.from(bytes)),{cMapUrl:path.join(resources,'cmaps')+path.sep,cMapPacked:true,standardFontDataUrl:path.join(resources,'standard_fonts')+path.sep,useWorkerFetch:false,disableFontFace:true});
try{const content=await (await pdf.getPage(1)).getTextContent();assert.equal(content.items.map(p=>'str' in p?p.str:'').join(''),text);}finally{await pdf.destroy?.();}
console.log('WR-T8 PASS: local/staged Chinese CMap text extraction, resource licenses and slim package.');
