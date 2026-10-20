import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSkillRuntime } from '@openclawx/contracts';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '../pi-tools.js';
import {
  filterMcpConnectionsForTask,
  filterMcpToolsetForTask,
  isFinanceLikeMcpName,
} from '../pi-runtime.js';

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: { ok: true } }),
  };
}

function skill(partial: Partial<AgentSkillRuntime> = {}): AgentSkillRuntime {
  return {
    id: partial.id || 'skill-baseline-pdf-report',
    name: partial.name || 'PDF 报告生成',
    description: partial.description || '生成 PDF 行程',
    mode: partial.mode || 'available',
    instructions: partial.instructions || 'Write the final PDF under output/.',
    resources: partial.resources ?? [],
    execution: partial.execution ?? {
      allowWorkspaceWrite: true,
      allowScriptExecution: true,
      allowedNetworkHosts: [],
      allowAllNonDestructive: false,
    },
  };
}

test('document artifact tasks retain associated domain MCP tools', () => {
  const filtered = filterMcpToolsetForTask({
    tools: [
      tool('mcp_akshare_list_akshare_categories_tool'),
      tool('mcp_sequential_thinking_sequentialthinking'),
      tool('mcp_filesystem_list_allowed_directories'),
      tool('mcp_amap_maps_geocode'),
    ],
    toolDescriptors: [
      { name: 'mcp_akshare_list_akshare_categories_tool', description: 'finance', inputSchema: { type: 'object' } },
      { name: 'mcp_sequential_thinking_sequentialthinking', description: 'reasoning', inputSchema: { type: 'object' } },
      { name: 'mcp_filesystem_list_allowed_directories', description: 'filesystem', inputSchema: { type: 'object' } },
      { name: 'mcp_amap_maps_geocode', description: 'map', inputSchema: { type: 'object' } },
    ],
    labels: ['Akshare', 'Sequential Thinking', 'Filesystem', 'Amap Maps'],
    instructions: 'Available MCP tools for this run: ...',
    close: async () => undefined,
  }, '创建一个从上海到西藏的10天的行程pdf', [skill()]);

  assert.deepEqual(filtered.tools.map((item) => item.name), ['mcp_akshare_list_akshare_categories_tool', 'mcp_amap_maps_geocode']);
  assert.deepEqual(filtered.labels, ['Akshare', 'Amap Maps']);
  assert.equal(filtered.instructions, '');
});

test('associated market MCP remains visible while filesystem stays blocked in project mode', () => {
  const filtered = filterMcpToolsetForTask({
    tools: [
      tool('mcp_akshare_list_akshare_categories_tool'),
      tool('mcp_filesystem_list_directory'),
      tool('mcp_memory_read_graph'),
    ],
    toolDescriptors: [
      { name: 'mcp_akshare_list_akshare_categories_tool', description: 'finance', inputSchema: { type: 'object' } },
      { name: 'mcp_filesystem_list_directory', description: 'filesystem', inputSchema: { type: 'object' } },
      { name: 'mcp_memory_read_graph', description: 'memory', inputSchema: { type: 'object' } },
    ],
    labels: ['Akshare', 'Filesystem', 'Memory'],
    instructions: 'Available MCP tools for this run: ...',
    close: async () => undefined,
  }, '收敛目标与交付边界，输出行动简报（受众含证券从业背景假设与金融质感）', [skill({
    id: 'skill-baseline-docx',
    name: 'Word 文档撰写',
    description: '起草正式文档',
    instructions: 'Write the brief under the project root.',
  })], { projectBound: true });

  assert.deepEqual(filtered.tools.map((item) => item.name), ['mcp_akshare_list_akshare_categories_tool', 'mcp_memory_read_graph']);
  assert.deepEqual(filtered.labels, ['Akshare', 'Memory']);
});

test('live market tasks keep akshare tools', () => {
  const filtered = filterMcpToolsetForTask({
    tools: [
      tool('mcp_akshare_get_a_share_quotes'),
      tool('mcp_filesystem_list_directory'),
    ],
    toolDescriptors: [
      { name: 'mcp_akshare_get_a_share_quotes', description: 'quotes', inputSchema: { type: 'object' } },
      { name: 'mcp_filesystem_list_directory', description: 'filesystem', inputSchema: { type: 'object' } },
    ],
    labels: ['Akshare', 'Filesystem'],
    instructions: '',
    close: async () => undefined,
  }, '拉取今日实时行情与股价涨跌幅并写入报告', [skill()]);

  assert.ok(filtered.tools.some((item) => item.name.includes('akshare')));
  assert.ok(!filtered.tools.some((item) => item.name.includes('filesystem')));
});

test('stock_sdk trading-day tools are finance-like but remain authorized when associated', () => {
  assert.equal(isFinanceLikeMcpName('mcp_stock_sdk_is_trading_day'), true);
  assert.equal(isFinanceLikeMcpName('stock_sdk'), true);
  assert.equal(isFinanceLikeMcpName('amap-maps'), false);

  const filtered = filterMcpToolsetForTask({
    tools: [
      tool('mcp_stock_sdk_is_trading_day'),
      tool('mcp_amap_maps_geocode'),
    ],
    toolDescriptors: [
      { name: 'mcp_stock_sdk_is_trading_day', description: 'trading day', inputSchema: { type: 'object' } },
      { name: 'mcp_amap_maps_geocode', description: 'map', inputSchema: { type: 'object' } },
    ],
    labels: ['stock_sdk', 'Amap Maps'],
    instructions: 'Available MCP tools for this run: ...',
    close: async () => undefined,
  }, '梳理计生用品主流品类，建立分类体系与合规文案规范文档', [skill()], { projectBound: true });

  assert.deepEqual(filtered.tools.map((item) => item.name), ['mcp_stock_sdk_is_trading_day', 'mcp_amap_maps_geocode']);
  assert.deepEqual(filtered.labels, ['stock_sdk', 'Amap Maps']);
});

test('filterMcpConnectionsForTask retains associated stock_sdk on project-bound doc tasks', () => {
  const kept = filterMcpConnectionsForTask(
    [
      { id: 'stock_sdk', name: 'Stock SDK', enabled: true },
      { id: 'amap', name: 'Amap Maps', enabled: true },
    ],
    '输出分类清单与合规文案规范',
    { projectBound: true },
  );
  assert.deepEqual(kept.map((item) => item.id), ['stock_sdk', 'amap']);
});

test('data-app instant programming blocks MCP fetch even when name is localized', () => {
  const filtered = filterMcpToolsetForTask({
    tools: [
      tool('mcp_fetch_fetch'),
      tool('mcp_amap_maps_geocode'),
    ],
    toolDescriptors: [
      { name: 'mcp_fetch_fetch', description: 'fetch url', inputSchema: { type: 'object' } },
      { name: 'mcp_amap_maps_geocode', description: 'map', inputSchema: { type: 'object' } },
    ],
    labels: ['Fetch 网页抓取', 'Amap Maps'],
    instructions: 'Available MCP tools for this run: ...',
    close: async () => undefined,
  }, '【数据工作台 · 即时编程】output/index.html 绑定 custom-site / data-apps/xxx', []);

  assert.deepEqual(filtered.tools.map((item) => item.name), ['mcp_amap_maps_geocode']);
  const kept = filterMcpConnectionsForTask(
    [
      { id: 'mcp-baseline-fetch', name: 'Fetch 网页抓取', enabled: true },
      { id: 'amap', name: 'Amap Maps', enabled: true },
    ],
    'instant program data-apps/ custom-site bind_data_app_custom_site',
  );
  assert.deepEqual(kept.map((item) => item.id), ['amap']);
});
