import path from 'node:path';
import {unzipSync} from 'fflate';
import * as XLSX from 'xlsx';
import {DocumentReadResultSchema,type DocumentReadResult,type DocumentInfo} from '@workmate/contracts';
import {parseLocalDocument,hasPptxEnhancedParser} from './document-parser.js';
import {DocumentProcessingError} from './document-errors.js';

const CONTEXT_LIMIT=500_000;
const TEXT=/\.(txt|md|markdown|json|html?|css|[cm]?js|tsx?|jsx|xml|ya?ml|log|sql)$/i;
export function supportsDocumentReading(fileName:string,mimeType?:string){return TEXT.test(fileName)||/\.(pdf|docx|pptx|ppsx|xlsx?|csv)$/i.test(fileName)||Boolean(mimeType?.startsWith('text/'));}

function sheetContext(bytes: Buffer, name: string) {
  const book = XLSX.read(bytes, { type: 'buffer', dense: true,sheetRows:101,...(/\.csv$/i.test(name)?{codepage:65001}:{}) });
  if (book.SheetNames.length > 30) throw new DocumentProcessingError('DOCUMENT_TOO_LARGE','工作簿最多支持 30 个工作表。');
  const parts = [`文件：${name}`, `工作表：${book.SheetNames.join('、')}`];
  let truncated=false;
  for (const sheetName of book.SheetNames) {
    const sheet = book.Sheets[sheetName];
    const ref=sheet['!fullref']||sheet['!ref'];
    const range = ref ? XLSX.utils.decode_range(ref) : null;
    if(range&&range.e.r-range.s.r+1>100)truncated=true;
    if (range && (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > 1_000_000) throw new DocumentProcessingError('DOCUMENT_TOO_LARGE',`工作表“${sheetName}”超过 100 万个单元格，请先精简。`);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: '' }).slice(0, 100);
    parts.push(`\n### 工作表：${sheetName}\n${rows.map((row) => row.map((cell) => String(cell).replace(/\|/g, '\\|')).join(' | ')).join('\n')}`);
    if (parts.join('\n').length > CONTEXT_LIMIT){truncated=true;break;}
  }
  return { context: parts.join('\n').slice(0, CONTEXT_LIMIT),truncated, summary: `${book.SheetNames.length} 个工作表 · 已提取前 100 行预览` };
}

function decodeXml(value: string) {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function xmlParagraphs(xml: string) {
  const paragraphs: string[] = [];
  for (const paragraph of xml.match(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g) ?? []) {
    const text = [...paragraph.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeXml(match[1] || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join('');
    if (text && paragraphs.at(-1) !== text) paragraphs.push(text);
  }
  return paragraphs;
}

function htmlContext(bytes: Buffer, name: string) {
  const source = bytes.toString('utf8').replace(/\u0000/g, '');
  const title = decodeXml(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const text = decodeXml(source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tfoot|tr)\s*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const context = [`文件：${name}`, ...(title ? [`标题：${title}`] : []), '', text].join('\n').trim().slice(0, CONTEXT_LIMIT);
  if (!text) throw new DocumentProcessingError('DOCUMENT_EMPTY','HTML 文件没有可读取的正文内容。');
  return { context, summary: `HTML 正文 · 已提取 ${Math.min(text.length, CONTEXT_LIMIT).toLocaleString()} 个字符` };
}

function presentationContext(bytes: Buffer, name: string,maxPages=300) {
  let archive: Record<string, Uint8Array>;
  let extractedBytes = 0;
  try {
    archive = unzipSync(new Uint8Array(bytes), { filter: (entry) => {
      const needed = /^ppt\/(slides\/slide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels|notesSlides\/notesSlide\d+\.xml)$/i.test(entry.name);
      if (!needed) return false;
      if (entry.originalSize > 5 * 1024 * 1024 || extractedBytes + entry.originalSize > 20 * 1024 * 1024) throw new Error('演示文稿解压后的文本结构过大，请先精简。');
      extractedBytes += entry.originalSize;
      return true;
    } });
  }
  catch (cause) {
    if (cause instanceof Error && cause.message.includes('解压后的文本结构过大')) throw cause;
    throw new Error('演示文稿结构损坏，无法读取。');
  }
  const decoder = new TextDecoder('utf-8');
  const slideEntries = Object.keys(archive)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry))
    .sort((left, right) => Number(left.match(/slide(\d+)/i)?.[1]) - Number(right.match(/slide(\d+)/i)?.[1]));
  if (!slideEntries.length) throw new Error('演示文稿没有可读取的幻灯片。');
  if (slideEntries.length > 300) throw new Error('演示文稿最多支持 300 页。');

  const pages: string[] = [];
  let readableSlides = 0;
  for (const entry of slideEntries.slice(0,maxPages)) {
    const index = Number(entry.match(/slide(\d+)/i)?.[1]);
    const paragraphs = xmlParagraphs(decoder.decode(archive[entry]));
    const relationEntry = `ppt/slides/_rels/slide${index}.xml.rels`;
    const relationXml = archive[relationEntry] ? decoder.decode(archive[relationEntry]) : '';
    const notesRelation = (relationXml.match(/<Relationship\b[^>]*\/?\s*>/gi) ?? []).find((tag) => /Type="[^"]*\/notesSlide"/i.test(tag));
    const notesTarget = notesRelation?.match(/Target="([^"]+)"/i)?.[1];
    const notesPath = notesTarget ? path.posix.normalize(path.posix.join('ppt/slides', notesTarget)) : '';
    const notes = notesPath && archive[notesPath]
      ? xmlParagraphs(decoder.decode(archive[notesPath])).filter((item) => !/^\d+$/.test(item))
      : [];
    if (paragraphs.length || notes.length) readableSlides += 1;
    const title = paragraphs[0] || `第 ${index} 页`;
    const body = paragraphs.slice(1);
    pages.push([
      `## 第 ${index} 页：${title}`,
      ...(body.length ? body : ['（本页没有可提取的正文文字）']),
      ...(notes.length ? ['', '### 演讲者备注', ...notes] : []),
    ].join('\n'));
  }
  const context = [`文件：${name}`, `幻灯片：${slideEntries.length} 页`, '', ...pages].join('\n\n');
  if(!readableSlides)throw new DocumentProcessingError('DOCUMENT_EMPTY','幻灯片没有可提取的正文或备注，请使用已授权Skill进一步处理。');
  return {
    context: context.slice(0, 500_000),
    pageCount:slideEntries.length,pagesRead:pages.length,truncated:pages.length<slideEntries.length||context.length>500000,
    summary: `${slideEntries.length} 页幻灯片 · ${readableSlides} 页含可读取文字 · 已提取正文与备注`,
  };
}


export type DocumentReadInput={
  fileName:string;bytes:Uint8Array;mimeType?:string;maxBytes?:number;maxPages?:number;maxChars?:number;
  timeoutMs?:number;allowEnhanced?:boolean;signal?:AbortSignal;
};

/** Shared deterministic document capability. Identity/file access and delegation belong to hosts. */
export async function readDocument(input:DocumentReadInput):Promise<DocumentReadResult>{
  const fileName=path.basename(input.fileName)+(input.mimeType==='application/pdf'&&!/\.pdf$/i.test(input.fileName)?'.pdf':''),format=(path.extname(fileName).slice(1).toLowerCase()||'text').slice(0,20);
  const info:DocumentInfo={format,truncated:false,warnings:[],nextAction:'none'};
  const check=()=>{if(input.signal?.aborted)throw new DocumentProcessingError('DOCUMENT_CANCELLED','文档读取已取消。');};
  try{
    check();
    if(!supportsDocumentReading(fileName,input.mimeType))throw new DocumentProcessingError('DOCUMENT_UNSUPPORTED','此格式尚无内置读取器，请打开原文件查看。');
    if(input.bytes.byteLength>(input.maxBytes??25*1024*1024))throw new DocumentProcessingError('DOCUMENT_TOO_LARGE','文档超过本次读取的大小限制，请精简后重试。');
    if(!input.bytes.byteLength)throw new DocumentProcessingError('DOCUMENT_EMPTY','文件为空，没有可提取的内容。');
    const bytes=Buffer.from(input.bytes),maxChars=Math.min(500000,Math.max(1,input.maxChars??500000));
    let text='';
    if(/\.(pdf|docx)$/i.test(fileName)||(/\.(pptx|ppsx)$/i.test(fileName)&&input.allowEnhanced&&await hasPptxEnhancedParser())){
      try{
        const parsed=await parseLocalDocument({...input,fileName,bytes,maxChars,allowEnhanced:Boolean(input.allowEnhanced)});
        text=parsed.markdown;info.parser=parsed.parser;info.pageCount=parsed.pageCount;info.pagesRead=parsed.pagesRead;info.truncated=Boolean(parsed.truncated);info.warnings=parsed.warnings.map(w=>w.slice(0,300)).slice(0,8);
      }catch(cause){
        if(!/\.(pptx|ppsx)$/i.test(fileName))throw cause;
        info.warnings.push('增强解析不可用，已回退内置幻灯片正文与备注提取。');
        const basic=presentationContext(bytes,fileName,input.maxPages??300);text=basic.context;info.pageCount=basic.pageCount;info.pagesRead=basic.pagesRead;info.truncated=basic.truncated;info.parser='builtin';
      }
    }else if(/\.(pptx|ppsx)$/i.test(fileName)){
      const basic=presentationContext(bytes,fileName,input.maxPages??300);text=basic.context;info.pageCount=basic.pageCount;info.pagesRead=basic.pagesRead;info.truncated=basic.truncated;info.parser='builtin';
    }else if(/\.(xlsx?|csv)$/i.test(fileName)){
      const preview=sheetContext(bytes,fileName);text=preview.context;info.truncated=preview.truncated;info.parser='builtin';info.warnings.push('表格读取为预览：最多30个工作表，每表前100行。');
    }else if(/\.html?$/i.test(fileName)){
      text=htmlContext(bytes,fileName).context;info.parser='builtin';
    }else{
      if(bytes.subarray(0,1024).includes(0))throw new DocumentProcessingError('DOCUMENT_PARSE_FAILED','文本文件包含二进制内容，无法按文本读取。');
      text=bytes.toString('utf8').replace(/\u0000/g,'').trim();info.parser='builtin';
    }
    check();
    if(!text.trim())throw new DocumentProcessingError('DOCUMENT_EMPTY','未提取到正文；可能需要其他解析器或OCR，不能据此认定文件无文字。');
    info.truncated ||= text.length>maxChars;
    return DocumentReadResultSchema.parse({ok:true,text:text.slice(0,maxChars),info});
  }catch(cause){
    const error=input.signal?.aborted?new DocumentProcessingError('DOCUMENT_CANCELLED','文档读取已取消。'):cause;
    const code=error instanceof DocumentProcessingError?error.code:'DOCUMENT_PARSE_FAILED';
    const message=error instanceof DocumentProcessingError?error.message:'文档内置解析未成功，可交给员工使用已授权Skill进一步处理；不要用历史摘要代替正文。';
    info.nextAction=['DOCUMENT_EMPTY','DOCUMENT_PARSE_FAILED','DOCUMENT_DEPENDENCY_MISSING'].includes(code)?'delegate':'none';
    return DocumentReadResultSchema.parse({ok:false,code,message:message.slice(0,300),info});
  }
}
