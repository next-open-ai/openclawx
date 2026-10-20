import type {DocumentErrorCode} from '@openclawx/contracts';
export class DocumentProcessingError extends Error {
  constructor(readonly code:DocumentErrorCode,message:string){super(message);}
}
