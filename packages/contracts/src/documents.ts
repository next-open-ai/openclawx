import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';

export const DocumentErrorCodeSchema=z.enum(['DOCUMENT_UNSUPPORTED','DOCUMENT_EMPTY','DOCUMENT_PARSE_FAILED','DOCUMENT_TOO_LARGE','DOCUMENT_CANCELLED','DOCUMENT_DEPENDENCY_MISSING','DOCUMENT_NOT_AVAILABLE','DOCUMENT_INVALID_INPUT']);
export const DocumentToolInputSchema=z.object({path:z.string().min(1).max(240),maxChars:z.number().int().min(1).max(16000).optional(),maxPages:z.number().int().min(1).max(300).optional()}).strict();
export const DocumentToolInputJsonSchema=zodToJsonSchema(DocumentToolInputSchema,{$refStrategy:'none'});
export const DocumentInfoSchema=z.object({format:z.string().max(20),parser:z.enum(['builtin','markitdown','docling']).optional(),pageCount:z.number().int().nonnegative().optional(),pagesRead:z.number().int().nonnegative().optional(),truncated:z.boolean(),warnings:z.array(z.string().max(300)).max(8),nextAction:z.enum(['none','delegate'])}).strict();
export const DocumentReadResultSchema=z.discriminatedUnion('ok',[
  z.object({ok:z.literal(true),text:z.string().max(500000),info:DocumentInfoSchema}).strict(),
  z.object({ok:z.literal(false),code:DocumentErrorCodeSchema,message:z.string().max(300),info:DocumentInfoSchema}).strict(),
]);
export type DocumentReadResult=z.infer<typeof DocumentReadResultSchema>;
export type DocumentInfo=z.infer<typeof DocumentInfoSchema>;
export type DocumentErrorCode=z.infer<typeof DocumentErrorCodeSchema>;
