import { defineConfig } from 'vitepress'

const architectureItems = [
  { text: '架构中心', link: '/architecture/README' },
  { text: '系统总览', link: '/architecture/system-overview' },
  { text: '全局架构', link: '/architecture/architecture' },
  { text: 'ADR 索引', link: '/architecture/adr/README' },
  { text: '应用模型能力运行时', link: '/architecture/application-model-capability-runtime' },
  { text: '执行后端', link: '/architecture/execution-backend' },
  { text: '项目编排', link: '/architecture/project-orchestration' },
  { text: '并发运行时', link: '/architecture/concurrency-runtime' },
  { text: '上下文治理', link: '/architecture/context-hygiene' },
  { text: '数据能力平台', link: '/architecture/data-capability-platform' },
  { text: '设置存储', link: '/architecture/settings-storage' },
  { text: 'AgentScope ABI', link: '/architecture/agentscope-abi' },
  { text: 'dsh Sidecar', link: '/architecture/dsh-sidecar' },
  { text: 'Embedding Provider', link: '/architecture/embedding-provider-v1' }
]

export default defineConfig({
  lang: 'zh-CN',
  title: 'OpenClawX Docs',
  description: 'OpenClawX 产品、架构、SDD、工程、测试与平台评测文档',
  base: './',
  cleanUrls: false,
  lastUpdated: true,
  outDir: '.vitepress/dist',
  head: [
    ['meta', { name: 'theme-color', content: '#6658e8' }],
    ['link', { rel: 'icon', href: './logo.svg', type: 'image/svg+xml' }]
  ],
  markdown: {
    lineNumbers: true,
    theme: { light: 'github-light', dark: 'github-dark' }
  },
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'OpenClawX Docs',
    nav: [
      { text: '首页', link: '/' },
      { text: '产品', link: '/product/README' },
      { text: '架构', link: '/architecture/README' },
      { text: 'SDD', link: '/sdd/README' },
      { text: '计划', link: '/planning/README' },
      { text: '质量', link: '/quality/README' },
      { text: 'Benchmark', link: '/benchmarks/README' },
      { text: '部署', link: '/deploy/README' }
    ],
    sidebar: [
      {
        text: '文档中心',
        items: [
          { text: '首页', link: '/' },
          { text: '完整导航', link: '/README' },
          { text: '当前功能状态', link: '/current-state' },
          { text: 'AI 编程文档方法论', link: '/ai-engineering-documentation-methodology' },
          { text: '产品总览', link: '/product/product-overview' },
          { text: '项目需求', link: '/product/requirements-overview' }
        ]
      },
      { text: '架构与 ADR', collapsed: true, items: architectureItems },
      {
        text: 'SDD 与计划',
        collapsed: false,
        items: [
          { text: 'SDD 索引', link: '/sdd/README' },
          { text: '轻量项目', link: '/sdd/features/lightweight-project-v1/README' },
          { text: '任务模板', link: '/architecture/task-template-pilot' },
          { text: '数据应用 SQL 与建表', link: '/sdd/features/managed-data-app-v1/sql-operations' },
          { text: '可信查询资产', link: '/sdd/features/agent-data-query-v1/query-assets' },
          { text: '本地优先经验', link: '/sdd/features/experience-local-first/README' },
          { text: 'UTI-001 · 统一 Tool Interface', link: '/sdd/features/unified-tool-interface/README' },
          { text: 'AMC-001 · 通用应用模型', link: '/sdd/features/application-model-capabilities/README' },
          { text: 'AMC-IMG-001 · 图片生成协议', link: '/sdd/features/application-model-capabilities/image-generation-protocols' },
          { text: '持续任务', link: '/sdd/features/conversation-durable-task/README' },
          { text: '本体增强 RAG', link: '/sdd/features/ontology-rag-phase-1/README' },
          { text: '实时语音 V1', link: '/sdd/features/realtime-voice-v1/status' },
          { text: '语音服务模块化', link: '/sdd/features/voice-services-modularization-v1/status' },
          { text: '测试控制台 V1', link: '/sdd/features/test-console-v1/README' },
          { text: '计划中心', link: '/planning/README' },
          { text: '项目路线图', link: '/planning/roadmap' },
          { text: '生命周期', link: '/lifecycle/README' },
          { text: '阶段成果', link: '/deliverables/README' }
        ]
      },
      {
        text: '测试与质量',
        collapsed: true,
        items: [
          { text: '质量中心', link: '/quality/README' },
          { text: '测试策略', link: '/quality/test-strategy' },
          { text: '回归套件', link: '/quality/regression-suite' },
          { text: '测试控制台', link: '/sdd/features/test-console-v1/requirements' },
          { text: '功能测试产物', link: '/quality/features/README' },
          { text: '版本测试产物', link: '/quality/releases/README' }
        ]
      },
      {
        text: '平台 Benchmark',
        collapsed: true,
        items: [
          { text: 'Benchmark 中心', link: '/benchmarks/README' },
          { text: '评测目录', link: '/benchmarks/catalog' },
          { text: '评测方法', link: '/benchmarks/methodology' },
          { text: '评测套件', link: '/benchmarks/suites/README' },
          { text: '基线', link: '/benchmarks/baselines/README' },
          { text: '报告', link: '/benchmarks/reports/README' },
          { text: '数据集', link: '/benchmarks/datasets/README' }
        ]
      },
      {
        text: '工程治理',
        collapsed: true,
        items: [
          { text: '工程规则', link: '/engineering/README' },
          { text: '编码智能体规则', link: '/engineering/agent-guidelines' },
          { text: 'SDD 工作流', link: '/engineering/sdd-workflow' },
          { text: '编码规范', link: '/engineering/coding-standards' },
          { text: '测试规范', link: '/engineering/testing' },
          { text: '文档治理', link: '/engineering/documentation' },
          { text: '评审清单', link: '/engineering/review-checklist' }
        ]
      },
      {
        text: '使用、迁移与发布',
        collapsed: true,
        items: [
          { text: '使用指南', link: '/guides/README' },
          { text: '用户手册', link: '/guides/user-manual' },
          { text: '运行形态', link: '/guides/runtime-modes' },
          { text: '迁移索引', link: '/migrations/README' },
          { text: '部署与运行', link: '/deploy/README' },
          { text: '发布记录', link: '/releases/README' },
          { text: '历史归档', link: '/archive/README' }
        ]
      }
    ],
    outline: { level: [2, 3], label: '本页目录' },
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                noResultsText: '没有找到相关内容',
                resetButtonTitle: '清除查询',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' }
              }
            }
          }
        }
      }
    },
    docFooter: { prev: '上一篇', next: '下一篇' },
    darkModeSwitchLabel: '主题',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '返回顶部',
    lastUpdated: { text: '最后更新' },
    footer: {
      message: 'OpenClawX 工程与产品知识库',
      copyright: 'Generated from the repository documentation source of truth.'
    }
  }
})
