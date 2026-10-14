import test from 'node:test';
import assert from 'node:assert/strict';
import {openLocalPdf} from '../pdf-document.js';
import {parseLocalDocument} from '../document-parser.js';
import {readDocument} from '../document-service.js';

function chinesePdf(){
  const text='上海至三亚旅游行程';
  const hex=Array.from(text).map(c=>c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
  const body=`BT /F1 12 Tf 40 700 Td <${hex}> Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>',`<< /Length ${body.length} >>\nstream\n${body}\nendstream`,'<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 0 >> /DW 1000 >>'];
  let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});const xref=pdf.length;
  pdf+=`xref\n0 7\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
test('WR-T8: actual Chinese CID PDF uses local CMaps, shared parser and no OCR',async()=>{
  const bytes=chinesePdf(),pdf=await openLocalPdf(new Uint8Array(bytes));
  try{
    const page=await pdf.getPage(1),content=await page.getTextContent();
    assert.match(content.items.map(p=>'str' in p?p.str:'').join(''),/上海至三亚旅游行程/);
  }finally{await (pdf as unknown as {destroy?:()=>Promise<void>}).destroy?.();}
  assert.match((await parseLocalDocument({fileName:'chinese.pdf',bytes})).markdown,/上海至三亚旅游行程/);
  const document=await readDocument({fileName:'chinese.pdf',bytes,maxPages:1,maxChars:16000});assert.equal(document.ok,true);
  if(document.ok){assert.match(document.text,/上海至三亚旅游行程/);assert.equal(document.info.pageCount,1);assert.equal(document.info.pagesRead,1);assert.equal(document.info.truncated,false);}
});
