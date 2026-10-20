# 本体增强 RAG 第一阶段

> 状态：实施中  
> 规格版本：0.1  
> 更新日期：2026-09-23

## 目标

在不替换现有知识库和向量检索的前提下，引入轻量本体与知识图谱，使 OpenClawX 能识别业务实体、别名和关系，并用这些结果增强向量召回、约束适用范围和解释检索结果。

## 核心结论

第一阶段不采用单一的“先图谱、后向量”硬串行，也不把所有候选直接交给大模型判断。采用“原始向量保底 + 本体增强查询 + 图谱定向召回 + 确定性融合”的方式：图谱负责找对对象和范围，向量库负责返回原文证据，大模型只负责基于已筛选证据生成答案。

## 规格导航

- [需求](requirements.md)
- [架构与契约](architecture.md)
- [实施计划](plan.md)
- [任务](tasks.md)
- [测试规格](test-spec.md)
- [追踪矩阵](traceability.md)
- [当前状态](status.md)

## 关联文档

- [全局架构](../../../architecture/architecture.md)
- [Embedding Provider](../../../architecture/embedding-provider-v1.md)
- [SDD 工作流](../../../engineering/sdd-workflow.md)
