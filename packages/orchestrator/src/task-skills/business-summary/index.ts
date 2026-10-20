import { BusinessSummaryInputSchema, BusinessSummaryResultSchema, type TaskTemplate, type TaskSkillDescriptor } from '@openclawx/contracts';
import { inputHtml } from './assets/input.js';
import { reportHtml } from './assets/report.js';

const entry = (name: string) => ({ skillId: 'business-summary', version: '1.0.0', entry: name });
export const businessSummaryTemplate: TaskTemplate = {
  id: 'business-summary', version: '1.0.0', name: '月度经营数据汇总',
  description: '填写业务收入与成本，生成指标、明细及可查询报告。无需配置模型。',
  input: entry('prepare'), execution: entry('execute'), output: entry('format'), view: entry('report'),
  resultType: 'business-summary', resultVersion: '1.0.0',
};
export const businessSummarySkill = {
  id: 'business-summary', version: '1.0.0', inputHtml,
  descriptor: {
    id: 'business-summary', version: '1.0.0', name: '经营数据汇总',
    description: '月度收入、成本与利润汇总；使用录入数据计算，无外部写入。',
    inputType: 'business-summary-input/1.0.0', resultType: 'business-summary', resultVersion: '1.0.0',
    entries: { input: 'prepare', execution: 'execute', output: 'format', view: 'report' },
    exports: ['json', 'html', 'csv'],
  } satisfies TaskSkillDescriptor,
  exportCsv(value: unknown) {
    const data = BusinessSummaryResultSchema.parse(value);
    const cell = (value: string | number) => {
      const raw = typeof value === 'string' && /^[\s]*[=+@-]/.test(value) ? "'" + value : String(value);
      return '"' + raw.replace(/"/g, '""') + '"';
    };
    return '\uFEFF' + [['业务 / 区域', '收入（元）', '成本（元）', '利润（元）'],
      ...data.rows.map(row => [row.name, row.revenue, row.cost, row.profit]),
    ].map(row => row.map(cell).join(',')).join('\r\n');
  },
  prepare: (parameters: unknown) => BusinessSummaryInputSchema.parse(parameters),
  execute(parameters: unknown) {
    const input = BusinessSummaryInputSchema.parse(parameters);
    const cents = (value: number) => Math.round(value * 100);
    const revenue = input.rows.reduce((sum, row) => sum + cents(row.revenue), 0);
    const cost = input.rows.reduce((sum, row) => sum + cents(row.cost), 0);
    return {
      period: input.period, currency: 'CNY', revenue: revenue / 100, cost: cost / 100,
      profit: (revenue - cost) / 100, margin: revenue === 0 ? null : (revenue - cost) / revenue,
      rows: input.rows.map(row => ({ ...row, profit: (cents(row.revenue) - cents(row.cost)) / 100 })),
      summary: `汇总 ${input.rows.length} 项业务数据；${input.rows.filter(row => row.cost > row.revenue).length} 项成本高于收入。`,
    };
  },
  format: (value: unknown) => BusinessSummaryResultSchema.parse(value),
  report: reportHtml,
};
