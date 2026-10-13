import { z } from 'zod';

export const TaskParameterUiSchema = z.object({
  version: z.literal(1), projectId: z.string().min(1).max(120), revision: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.record(z.string().min(1).max(160), z.string().max(256_000)).superRefine((files, ctx) => {
    if (!files['index.html']?.trim() || !files['input.schema.json']) ctx.addIssue({ code: 'custom', message: '必须提供 index.html 和 input.schema.json' });
    if (Object.keys(files).length > 30 || Object.values(files).reduce((n, s) => n + s.length, 0) > 1_000_000) ctx.addIssue({ code: 'custom', message: '参数 UI 最多30个文件、合计1MB' });
    for (const name of Object.keys(files)) if (!/^(?:[\w-]+\/)*[\w-]+(?:\.[\w-]+)*\.(html|css|js|json|md)$/.test(name)) ctx.addIssue({ code: 'custom', message: `不支持的参数 UI 文件路径：${name}` });
  }),
}).strict();
export type TaskParameterUi = z.infer<typeof TaskParameterUiSchema>;
export const TaskReportUiSchema=TaskParameterUiSchema.extend({files:z.record(z.string().min(1).max(160),z.string().max(256_000)).superRefine((files,ctx)=>{
  if(!files['index.html']?.trim())ctx.addIssue({code:'custom',message:'任务报告必须提供 index.html'});
  if(Object.keys(files).length>30||Object.values(files).reduce((n,s)=>n+s.length,0)>1_000_000)ctx.addIssue({code:'custom',message:'任务报告最多30个文件、合计1MB'});
  for(const name of Object.keys(files))if(!/^(?:[\w-]+\/)*[\w-]+(?:\.[\w-]+)*\.(html|css|js|json|md)$/.test(name))ctx.addIssue({code:'custom',message:'不支持的任务报告资源路径'});
})});
export type TaskReportUi=z.infer<typeof TaskReportUiSchema>;
export const TaskReportProjectPreviewSchema=z.object({definitionId:z.string(),revision:z.string(),html:z.string()}).strict();
export const TaskParameterProjectInfoSchema = z.object({definitionId:z.string().min(1).nullable(),kind:z.enum(['parameters','report']).optional()}).strict();
export const TaskParameterProjectPreviewSchema = z.object({
  definitionId:z.string().min(1), revision:z.string().regex(/^[a-f0-9]{64}$/),
  html:z.string(), schema:z.unknown(), parameters:z.record(z.unknown()),
}).strict();
export type TaskParameterProjectPreview = z.infer<typeof TaskParameterProjectPreviewSchema>;
export const TaskParameterSkillOptionSchema = z.object({id:z.string().min(1).max(120),name:z.string().max(200),description:z.string().max(1000)}).strict();
export const TaskParameterSkillListSchema = z.object({skills:z.array(TaskParameterSkillOptionSchema).max(1000)}).strict();

/** Bounded, value-free field feedback shared by draft validation and its form host. */
export const TaskTemplateProblemSchema=z.object({code:z.enum(['PARAMETER_EXECUTION_MISMATCH','EXECUTION_INPUT_INVALID']),message:z.string(),target:z.enum(['execution','parameters'])});
export type TaskTemplateProblem=z.infer<typeof TaskTemplateProblemSchema>;
export function taskExecutionInputProblem(error:unknown,skillName:string,customUi:boolean):TaskTemplateProblem|undefined {
  if(!(error instanceof z.ZodError))return;
  const missing=error.issues.filter(issue=>issue.code==='invalid_type'&&issue.received==='undefined').slice(0,6).map(issue=>issue.path.join('.').slice(0,80));
  const labels:Record<string,string>={period:'统计月份（period）',rows:'经营明细（rows）'};
  const fields=missing.map(key=>labels[key]||key).join('、');
  if(customUi&&(missing.length||error.issues.some(issue=>issue.code==='unrecognized_keys')))return {code:'PARAMETER_EXECUTION_MISMATCH',target:'execution',message:`验证未通过：参数界面与执行方式不匹配。当前执行方式“${skillName.slice(0,100)}”${fields?`需要 ${fields}，当前页面未提供这些输入`:'无法接受当前页面提交的字段'}。请返回“执行能力”选择适合的智能体；如果确实要用当前 Skill，请修改参数界面以符合它的输入要求。重复提交相同参数不会解决此问题。`};
  return {code:'EXECUTION_INPUT_INVALID',target:'parameters',message:`验证未通过：${fields?`请填写 ${fields}`:'请检查参数的格式、范围及字段是否符合当前 Skill 要求'}。请修改参数后重试。`};
}

export function parameterValidationMessage(error: z.ZodError, schema: unknown, purpose: 'defaults' | 'test' = 'defaults'): string {
  const labels = error.issues.slice(0, 6).map(issue => {
    let node: any = schema;
    for (const key of issue.path) node = typeof key === 'number' ? node?.items : node?.properties?.[key];
    const label = String(node?.title || issue.path.join('.') || '参数').slice(0, 80);
    const problem = issue.code === 'invalid_type' && issue.received === 'undefined' ? '未填写'
      : issue.code === 'too_small' ? '内容不足或数值过小'
      : issue.code === 'too_big' ? '内容过长或数值过大'
      : issue.code === 'unrecognized_keys' ? '包含未定义字段' : '格式或选项无效';
    return `${label}：${problem}`;
  });
  return `${purpose === 'test' ? '测试参数' : '默认参数'}校验未通过：${labels.join('；')}${error.issues.length > 6 ? '；另有其他字段需要检查' : ''}。${purpose === 'test' ? '请填写测试参数后重新验证。' : '请打开“设置默认参数”填写并应用后重试。'}`;
}

/** Small explicit JSON Schema subset, shared by the API and form acceptance. */
export function parameterValidator(schema: unknown): z.ZodTypeAny {
  let nodes = 0;
  function build(raw: unknown, depth: number): z.ZodTypeAny {
    if (++nodes > 500 || depth > 10 || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('参数 Schema 结构无效或过于复杂');
    const s = raw as Record<string, any>;
    const allowed = ['type','properties','required','additionalProperties','items','enum','title','description','default','minimum','maximum','minLength','maxLength','minItems','maxItems','format','$schema'];
    for (const key of Object.keys(s)) if (!allowed.includes(key)) throw new Error(`不支持的 Schema 字段：${key}`);
    let v: z.ZodTypeAny;
    if (s.type === 'object') {
      if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) throw new Error('object Schema 必须提供 properties');
      if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((key: unknown) => typeof key !== 'string' || !Object.hasOwn(s.properties, key)))) throw new Error('required 必须引用已定义字段');
      if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') throw new Error('additionalProperties 必须为布尔值');
      const fields: Record<string, z.ZodTypeAny> = Object.create(null);
      for (const [key, child] of Object.entries(s.properties)) {
        if (['__proto__','prototype','constructor'].includes(key)) throw new Error('参数字段名无效');
        fields[key] = build(child, depth + 1); if (!s.required?.includes(key)) fields[key] = fields[key].optional();
      }
      v = s.additionalProperties === true ? z.object(fields).passthrough() : z.object(fields).strict();
    } else if (s.type === 'string') {
      let value = z.string();
      if (s.minLength !== undefined) value = value.min(bound(s.minLength));
      if (s.maxLength !== undefined) value = value.max(bound(s.maxLength));
      if (s.format === 'date') value = value.date();
      else if (s.format === 'date-time') value = value.datetime({ offset: true });
      else if (s.format === 'email') value = value.email();
      else if (s.format === 'uri') value = value.url();
      else if (s.format !== undefined) throw new Error(`不支持的 format：${s.format}`);
      v = value;
    } else if (s.type === 'number' || s.type === 'integer') {
      let value = z.number().finite(); if (s.type === 'integer') value = value.int();
      if (s.minimum !== undefined) value = value.min(finite(s.minimum));
      if (s.maximum !== undefined) value = value.max(finite(s.maximum));
      v = value;
    } else if (s.type === 'boolean') v = z.boolean();
    else if (s.type === 'array') {
      let value = z.array(build(s.items, depth + 1)).max(1000);
      if (s.minItems !== undefined) value = value.min(bound(s.minItems));
      if (s.maxItems !== undefined) value = value.max(Math.min(1000,bound(s.maxItems)));
      v = value;
    } else throw new Error(`不支持的参数类型：${s.type}`);
    if (s.enum !== undefined) {
      if (!Array.isArray(s.enum) || !s.enum.length || s.enum.length > 1000 || s.enum.some((x: unknown) => !['string','number','boolean'].includes(typeof x))) throw new Error('enum 必须为非空基本值数组');
      v = v.refine(x => s.enum.includes(x), '请选择有效选项');
    }
    return v;
  }
  function finite(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Schema 数值边界无效'); return value; }
  function bound(value: unknown) { const n = finite(value); if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new Error('Schema 长度边界无效'); return n; }
  if ((schema as any)?.type !== 'object') throw new Error('参数 Schema 根节点必须是 object');
  return build(schema, 0);
}

export const TaskParameterProjectOperationSchema = z.object({revision:z.number().int().positive(),employeeId:z.string().min(1).max(120).default('general')}).strict();
