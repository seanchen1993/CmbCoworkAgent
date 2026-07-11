# Trace 可观测字段服务端补齐方案

## 背景

新版本客户端会在 trace 和 code event 中上报 root/subagent 关联字段，用于运营面板按 root thread 聚合会话，并展示 Agent Team、Ultra Workflow、Task Agent 的父子关系。

历史数据没有采集 coordinator / workflow 模式，也没有子 trace 关联字段。为了让运营面板保持简单且查询高效，服务端需要对历史数据做一次最低字段补齐，并在入库链路对未升级客户端的数据做兜底补齐。

## 目标

1. 历史 trace 在新运营面板 Thread 维度下不丢失。
2. 历史 code_gen / code_adopt event 能继续关联到会话历史。
3. 未升级客户端继续上报老格式数据时，服务端自动补齐最低字段。
4. 补齐逻辑必须向前兼容：只补缺失字段，不覆盖新版本客户端已上报的真实 root/subagent 字段。

## 字段规则

### Trace 索引顶层字段

历史 trace 默认视为主 Agent 单 trace，不存在子 trace：

| 字段 | 补齐规则 | 说明 |
| --- | --- | --- |
| `observabilitySchemaVersion` | 缺失时补 `1` | 当前可观测扁平字段版本 |
| `traceKind` | 缺失时补 `"root"` | 历史数据没有子 trace，默认主 trace |
| `executionMode` | 缺失时补 `"normal"` | 已确认历史没有 coordinator/workflow |
| `rootTraceId` | 缺失时补 `traceId` | root trace 指向自身 |
| `rootThreadId` | 缺失时补 `threadId` | Thread 聚合必须字段 |

### Event 索引 `properties` 字段

对 `eventName in ("code_gen", "code_adopt")` 的事件补齐：

| 字段 | 补齐规则 | 说明 |
| --- | --- | --- |
| `properties.observabilitySchemaVersion` | 缺失时补 `1` | 与 trace 字段版本一致 |
| `properties.traceKind` | 缺失时补 `"root"` | 历史代码事件来自主 Agent |
| `properties.executionMode` | 缺失时补 `"normal"` | 已确认历史没有 coordinator/workflow |
| `properties.rootTraceId` | 缺失且 `properties.traceId` 存在时补 `properties.traceId` | 代码生成发生在哪个 root trace |
| `properties.rootThreadId` | 缺失且 `properties.threadId` 存在时补 `properties.threadId` | commit / 未提交代码关联会话使用 |

注意：不要给历史数据补 `parentTraceId`、`parentThreadId`、`subagentKind`、`workflowRunId`、`coordinatorWorkerId` 等字段。历史数据无法可靠还原这些关系，留空即可。

## 不可覆盖原则

补齐逻辑必须满足：

1. 字段已存在且非空时，不覆盖。
2. `traceKind="subagent"` 的新数据，不允许被改成 `"root"`。
3. `executionMode="coordinator"` 或 `"workflow"` 的新数据，不允许被改成 `"normal"`。
4. `rootTraceId/rootThreadId` 已存在时，不允许改成自身 ID。
5. 如果记录已经标记为 `traceKind="subagent"`，但缺少 `rootTraceId/rootThreadId`，不要用自身 ID 兜底，应记录异常并保留原值。
6. 缺少 `traceId` 或 `threadId` 的异常记录只补能确定的字段，不能造随机值。

推荐统一判断空值：

```ts
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === ""
}
```

## 历史数据回填

### Trace 回填伪代码

```ts
for each traceDoc in traceIndex:
  if blank(traceDoc.observabilitySchemaVersion):
    traceDoc.observabilitySchemaVersion = 1

  if blank(traceDoc.traceKind):
    traceDoc.traceKind = "root"

  if blank(traceDoc.executionMode):
    traceDoc.executionMode = "normal"

  if blank(traceDoc.rootTraceId) and not blank(traceDoc.traceId):
    traceDoc.rootTraceId = traceDoc.traceId

  if blank(traceDoc.rootThreadId) and not blank(traceDoc.threadId):
    traceDoc.rootThreadId = traceDoc.threadId
```

### Event 回填伪代码

```ts
for each eventDoc in eventIndex where eventName in ["code_gen", "code_adopt"]:
  props = eventDoc.properties ?? {}

  if blank(props.observabilitySchemaVersion):
    props.observabilitySchemaVersion = 1

  if blank(props.traceKind):
    props.traceKind = "root"

  if blank(props.executionMode):
    props.executionMode = "normal"

  if blank(props.rootTraceId) and not blank(props.traceId):
    props.rootTraceId = props.traceId

  if blank(props.rootThreadId) and not blank(props.threadId):
    props.rootThreadId = props.threadId

  eventDoc.properties = props
```

### ES Update By Query 示例

Trace 索引：

```json
POST devclaw_trace/_update_by_query?conflicts=proceed
{
  "script": {
    "lang": "painless",
    "source": """
      if (ctx._source.observabilitySchemaVersion == null) ctx._source.observabilitySchemaVersion = 1;
      if (ctx._source.traceKind == null || ctx._source.traceKind == '') ctx._source.traceKind = 'root';
      if (ctx._source.executionMode == null || ctx._source.executionMode == '') ctx._source.executionMode = 'normal';
      def rootLike = ctx._source.traceKind == null || ctx._source.traceKind == '' || ctx._source.traceKind == 'root';
      if (rootLike && (ctx._source.rootTraceId == null || ctx._source.rootTraceId == '') && ctx._source.traceId != null && ctx._source.traceId != '') {
        ctx._source.rootTraceId = ctx._source.traceId;
      }
      if (rootLike && (ctx._source.rootThreadId == null || ctx._source.rootThreadId == '') && ctx._source.threadId != null && ctx._source.threadId != '') {
        ctx._source.rootThreadId = ctx._source.threadId;
      }
    """
  },
  "query": {
    "bool": {
      "should": [
        { "bool": { "must_not": { "exists": { "field": "rootThreadId" } } } },
        { "bool": { "must_not": { "exists": { "field": "rootTraceId" } } } },
        { "bool": { "must_not": { "exists": { "field": "traceKind" } } } },
        { "bool": { "must_not": { "exists": { "field": "executionMode" } } } },
        { "bool": { "must_not": { "exists": { "field": "observabilitySchemaVersion" } } } }
      ],
      "minimum_should_match": 1
    }
  }
}
```

Event 索引：

```json
POST devclaw_event/_update_by_query?conflicts=proceed
{
  "script": {
    "lang": "painless",
    "source": """
      if (ctx._source.properties == null) ctx._source.properties = new HashMap();
      def p = ctx._source.properties;
      if (p.observabilitySchemaVersion == null) p.observabilitySchemaVersion = 1;
      if (p.traceKind == null || p.traceKind == '') p.traceKind = 'root';
      if (p.executionMode == null || p.executionMode == '') p.executionMode = 'normal';
      def rootLike = p.traceKind == null || p.traceKind == '' || p.traceKind == 'root';
      if (rootLike && (p.rootTraceId == null || p.rootTraceId == '') && p.traceId != null && p.traceId != '') {
        p.rootTraceId = p.traceId;
      }
      if (rootLike && (p.rootThreadId == null || p.rootThreadId == '') && p.threadId != null && p.threadId != '') {
        p.rootThreadId = p.threadId;
      }
    """
  },
  "query": {
    "bool": {
      "filter": [
        { "terms": { "eventName": ["code_gen", "code_adopt"] } }
      ],
      "should": [
        { "bool": { "must_not": { "exists": { "field": "properties.rootThreadId" } } } },
        { "bool": { "must_not": { "exists": { "field": "properties.rootTraceId" } } } },
        { "bool": { "must_not": { "exists": { "field": "properties.traceKind" } } } },
        { "bool": { "must_not": { "exists": { "field": "properties.executionMode" } } } },
        { "bool": { "must_not": { "exists": { "field": "properties.observabilitySchemaVersion" } } } }
      ],
      "minimum_should_match": 1
    }
  }
}
```

生产执行建议：

1. 先加 `slices=auto&wait_for_completion=false` 异步执行，避免长事务阻塞。
2. 按时间分批更稳，例如按 `startedAt/eventTime` 月度分批。
3. 每批记录 task id、updated 数、version_conflicts 数。
4. 支持重复执行，脚本必须幂等。

## 服务端入库兜底

历史回填只能修存量数据。为了兼容未升级客户端，服务端入库链路也需要在写 ES 前执行同样的补齐。

### Trace 入库兜底

```ts
function normalizeTraceForIndex(doc: Record<string, unknown>): Record<string, unknown> {
  if (isBlank(doc.observabilitySchemaVersion)) doc.observabilitySchemaVersion = 1
  if (isBlank(doc.traceKind)) doc.traceKind = "root"
  if (isBlank(doc.executionMode)) doc.executionMode = "normal"

  const rootLike = isBlank(doc.traceKind) || doc.traceKind === "root"
  if (rootLike && isBlank(doc.rootTraceId) && !isBlank(doc.traceId)) doc.rootTraceId = doc.traceId
  if (rootLike && isBlank(doc.rootThreadId) && !isBlank(doc.threadId)) doc.rootThreadId = doc.threadId

  if (doc.traceKind === "subagent" && (isBlank(doc.rootTraceId) || isBlank(doc.rootThreadId))) {
    // Do not self-link a subagent. Keep the data as-is and emit a warning/metric.
  }
  return doc
}
```

### Event 入库兜底

```ts
function normalizeEventForIndex(doc: Record<string, unknown>): Record<string, unknown> {
  const eventName = String(doc.eventName ?? "")
  if (eventName !== "code_gen" && eventName !== "code_adopt") return doc

  const props = (doc.properties && typeof doc.properties === "object")
    ? doc.properties as Record<string, unknown>
    : {}

  if (isBlank(props.observabilitySchemaVersion)) props.observabilitySchemaVersion = 1
  if (isBlank(props.traceKind)) props.traceKind = "root"
  if (isBlank(props.executionMode)) props.executionMode = "normal"

  const rootLike = isBlank(props.traceKind) || props.traceKind === "root"
  if (rootLike && isBlank(props.rootTraceId) && !isBlank(props.traceId)) {
    props.rootTraceId = props.traceId
  }
  if (rootLike && isBlank(props.rootThreadId) && !isBlank(props.threadId)) {
    props.rootThreadId = props.threadId
  }

  if (props.traceKind === "subagent" && (isBlank(props.rootTraceId) || isBlank(props.rootThreadId))) {
    // Do not self-link a subagent event. Keep the data as-is and emit a warning/metric.
  }

  doc.properties = props
  return doc
}
```

## 是否需要修改 `_raw`

最低补齐不要求改写 trace 文档里的 `_raw`。运营面板查询会读取 ES 顶层字段，并在 `_raw` 缺少新字段时回退到顶层字段。

如果服务端实现可以安全解析并重写 `_raw`，也可以同步写入同样字段；但这不是最低要求。优先保证顶层字段和 `properties` 字段正确，避免因为历史 `_raw` 格式差异引入额外风险。

## ES Mapping

如果索引是动态 mapping，回填会自动创建字段，但仍建议显式添加 mapping，避免字段类型漂移。

Trace 索引建议字段：

```json
{
  "observabilitySchemaVersion": { "type": "integer" },
  "traceKind": { "type": "keyword" },
  "executionMode": { "type": "keyword" },
  "rootTraceId": { "type": "keyword" },
  "rootThreadId": { "type": "keyword" }
}
```

Event 索引建议字段：

```json
{
  "properties.observabilitySchemaVersion": { "type": "integer" },
  "properties.traceKind": { "type": "keyword" },
  "properties.executionMode": { "type": "keyword" },
  "properties.rootTraceId": { "type": "keyword" },
  "properties.rootThreadId": { "type": "keyword" }
}
```

最低查询可用性最关键的是：

1. `rootThreadId`
2. `properties.rootThreadId`
3. `rootTraceId`
4. `properties.rootTraceId`

`traceKind` 和 `executionMode` 主要用于展示与后续按模式分析。

## 验证方式

### 回填前统计缺失量

Trace：

```json
GET devclaw_trace/_count
{
  "query": {
    "bool": {
      "must_not": { "exists": { "field": "rootThreadId" } }
    }
  }
}
```

Event：

```json
GET devclaw_event/_count
{
  "query": {
    "bool": {
      "filter": [{ "terms": { "eventName": ["code_gen", "code_adopt"] } }],
      "must_not": { "exists": { "field": "properties.rootThreadId" } }
    }
  }
}
```

### 回填后抽样校验

Trace：

```json
GET devclaw_trace/_search
{
  "size": 20,
  "_source": ["traceId", "threadId", "rootTraceId", "rootThreadId", "traceKind", "executionMode"],
  "query": {
    "bool": {
      "filter": [
        { "exists": { "field": "threadId" } },
        { "exists": { "field": "rootThreadId" } }
      ]
    }
  }
}
```

Event：

```json
GET devclaw_event/_search
{
  "size": 20,
  "_source": [
    "eventName",
    "properties.traceId",
    "properties.threadId",
    "properties.rootTraceId",
    "properties.rootThreadId",
    "properties.traceKind",
    "properties.executionMode"
  ],
  "query": {
    "bool": {
      "filter": [
        { "terms": { "eventName": ["code_gen", "code_adopt"] } },
        { "exists": { "field": "properties.rootThreadId" } }
      ]
    }
  }
}
```

### 不覆盖新数据校验

确认子 Agent 数据没有被误刷成自指 root。抽样检查 `traceKind=subagent`：

```json
GET devclaw_trace/_search
{
  "size": 20,
  "_source": ["traceId", "threadId", "rootTraceId", "rootThreadId", "traceKind", "executionMode", "subagentKind"],
  "query": {
    "bool": {
      "filter": [
        { "term": { "traceKind": "subagent" } }
      ]
    }
  }
}
```

检查要点：真实子 trace 应保留 `rootTraceId != traceId`、`rootThreadId != threadId` 的关联；如果发现 subagent 缺 root 字段，应修客户端或入库上游，而不是在回填脚本里自指补齐。

## 兼容性结论

1. 不刷历史数据，新 app 不会崩，但运营面板 Thread 聚合和 commit 关联会话会对老数据不完整。
2. 刷历史数据后，新 app 的 Thread 视图和代码采纳会话入口更完整，运营面板 DSL 可以保持简单。
3. 老 app 读取已补字段数据不会受影响，新增字段会被忽略。
4. 未升级老 app 后续继续上报老格式数据时，必须靠服务端入库兜底补齐，否则仍会产生缺字段的新数据。
