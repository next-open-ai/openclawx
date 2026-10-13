# 受控关联与条件聚合 SDQ-v2

版本 2.0；2026-10-12；状态：已实现，隔离回归通过；真实 MySQL/PostgreSQL 验收未执行。扩展 [v1](../structured-data-query-v1/README.md)，保持单表及旧 GET 兼容。证据见 [实施状态](status.md)。

## 需求、契约与任务

- SDQ2-R1/T1：metrics 增加可选 filters，每个指标独立 CASE WHEN，条件不匹配为 NULL；count(*) 条件计数使用 1，sum 无匹配返回 NULL。全局 filters 仍先筛选，HAVING 在聚合后生效；全局与各指标筛选条件总计不超过50，HAVING另限20。
- SDQ2-R2/T2：对象 annotations.relations 登记 id/name/fromTableId/toTableId/keys[{fromFieldId,toFieldId}]。只允许同对象、同类型字段、不同表、1–5键；方向为多对一。仅对象所有者可登记；模型只读关系，不能登记关系或提交 ON/SQL。
- SDQ2-R3/T3：query.joins 最多3个 {relationId,type:inner|left}，按已连接表到未连接表的有向顺序，拒绝循环、反向、重复、跨对象。基础字段保持原ID，关联字段为 tableId::columnId。本地表和单连接实时对象共用编译器，不跨源。
- SDQ2-R4/T3：执行前检查目标组合键唯一性（非 NULL 键）及实际匹配数，远端在同一可重复读事务内检查，本地 sql.js 同步执行无异步间隙。不满足返回 JOIN_CARDINALITY_VIOLATION，拒绝重复累计；不自动 DISTINCT/SUM DISTINCT 掩盖问题。NULL 键不匹配，LEFT 不丢基础行，WHERE 引用右表会按标准 SQL 筛掉 NULL 行。
- SDQ2-R5/T4：问数复核关联列、关联键及指标条件中的敏感字段；模型 Schema 仅提供可见关系。所有表仍通过 owner/org 核对，实时绑定只从服务端登记信息读取。
- SDQ2-R6/T5：测试包括 SQLite 实际多表/链式/LEFT/复合键、条件聚合+HAVING+排序绑定、目标重复拒绝、非法关系与跨用户/组织HTTP、远端两方言只读与回滚、敏感关系拒绝。

范围：网关API、关系登记API及模型Tools。现有简单查询UI不扩展关系编辑器；关系通过对象标注API登记，不自动发现外键。非目标：一对多膨胀查询、自连接、任意表达式、跨连接、窗口函数、真实业务库操作。

## 使用示例

先通过 `GET /data/gateway/schema?sourceId=...` 读取真实表/列 ID，然后由对象所有者向 `PATCH /data/sources/:sourceId/annotations` 保存完整标注中的 relations（此处仅列出关系字段，其他说明按原值保留）：

```json
{"relations":[{"id":"order_customer","name":"订单所属客户","fromTableId":"orders-id","toTableId":"customers-id","keys":[{"fromFieldId":"c_1","toFieldId":"c_1"}]}]}
```

再向 `POST /data/gateway/query` 提交：

```json
{
  "sourceId":"object-id","tableId":"orders-id",
  "joins":[{"relationId":"order_customer","type":"left"}],
  "dimensions":[{"fieldId":"customers-id::c_2"}],
  "metrics":[
    {"fieldId":"c_3","operation":"sum","alias":"paid_amount","filters":{"fieldId":"c_4","operator":"eq","value":"已付款"}},
    {"operation":"count","alias":"unpaid_count","filters":{"fieldId":"c_4","operator":"eq","value":"未付款"}}
  ],
  "having":[{"fieldId":"paid_amount","operator":"gt","value":10000}],
  "orderBy":[{"fieldId":"paid_amount","direction":"desc"}],"limit":10
}
```

对象所属权/表登记/关系方向/字段类型/敏感字段/目标唯一性失败均明确拒绝；目标非唯一为 HTTP409 `JOIN_CARDINALITY_VIOLATION`，错误不返回原始SQL或凭据。字段ID仅作示意，不能直接用于真实对象。条件计数没有匹配时为0；条件SUM没有匹配时为NULL，不擅自改变业务空值口径。两种能力可独立使用。

## 兼容、风险与回滚

新增可选字段；老 annotations 缺失关系按空数组读取，保留已登记关系的旧客户端标注保存不得隐式删除。无原库DDL/数据迁移。目标唯一性检查增加读开销；实时事务使用可重复读快照避免预检和聚合看到不同数据，不等于业务Schema约束。关闭 joins/metrics.filters 使用即回到单表行为，关系元数据可保留。真实 MySQL/PostgreSQL 另行验收；不接用户数据库。
