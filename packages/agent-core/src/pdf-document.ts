import {createRequire} from 'node:module';
import path from 'node:path';
import {getDocumentProxy} from 'unpdf';

/** Local resources only: CID Chinese fonts need CMaps even for text extraction. */
export function openLocalPdf(bytes:Uint8Array):ReturnType<typeof getDocumentProxy>{
  const root=path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  return getDocumentProxy(bytes,{
    cMapUrl:path.join(root,'cmaps')+path.sep,cMapPacked:true,
    standardFontDataUrl:path.join(root,'standard_fonts')+path.sep,
    useWorkerFetch:false,disableFontFace:true,useSystemFonts:true,
  });
}
