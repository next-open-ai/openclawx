import { z } from 'zod';
export const dataSchemaProposalSchema=z.object({description:z.string().trim().min(1).max(1000),sql:z.array(z.string().trim().min(1).max(6000)).min(1).max(10)}).strict();
export const dataSchemaExecuteSchema=z.object({revision:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true),includeInObject:z.literal(true)}).strict();
export const dataSchemaAccessSchema=z.object({enabled:z.boolean(),confirmed:z.literal(true)}).strict();
export type DataSchemaProposal=z.infer<typeof dataSchemaProposalSchema>;
export type DataSchemaPlan={id:string;sourceId:string;revision:string;description:string;sql:string[];tables:string[];state:'draft'|'executing'|'applied'|'failed'|'partial'|'unconfirmed';completed:number;createdAt:number;tableIds?:string[];error?:string};
