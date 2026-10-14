import type {DocumentErrorCode} from '@workmate/contracts';
export class DocumentProcessingError extends Error {
  constructor(readonly code:DocumentErrorCode,message:string){super(message);}
}
