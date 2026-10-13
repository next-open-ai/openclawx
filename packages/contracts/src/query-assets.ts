import { z } from 'zod';
import { structuredDataQuerySchema,type StructuredDataQuery } from './data-query.js';
import { dataAppSqlOperationSchema, dataAppParametersSchema,type DataAppSqlOperation } from './data-app-query.js';
export const queryAssetDefinitionSchema = z.union([
  z.object({kind:z.literal('structured'),query:structuredDataQuerySchema}).strict(),
  z.object({kind:z.literal('sql'),operation:dataAppSqlOperationSchema}).strict(),
]);
export const saveQueryAssetSchema=z.object({receiptId:z.string().uuid().optional(),name:z.string().trim().min(1).max(100),businessNote:z.string().trim().max(1000).default('')}).strict();
export const listQueryAssetsSchema=z.object({search:z.string().trim().max(100).default(''),sourceId:z.string().max(128).optional()}).strict();
export const runQueryAssetSchema=z.object({assetId:z.string().uuid(),parameters:dataAppParametersSchema.default({})}).strict();
export type QueryAssetDefinition={kind:'structured';query:StructuredDataQuery}|{kind:'sql';operation:DataAppSqlOperation};
export type QueryAsset={id:string;name:string;question:string;businessNote:string;sourceId:string;tableIds:string[];schemaFingerprint:string;definition:QueryAssetDefinition;version:1;status:'execution-verified';createdAt:number;receiptId:string};
