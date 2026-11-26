# 研发效能扩展：内网 Java 数据同步与月度填报实施说明

更新日期：2026-11-16

编写依据：现有《项目度量看板设计》第一部分的 Java 同步方案，以及负责人提供的实际 ES mapping、项目和特性关系接口样例。本文已经展开本次开发需要的基础与增量，不要求收件人同时取得原文档。

**目标：** 在现有内网 Java 同步程序上增加项目开发报工、PM、项目与特性关系以及特性事实，并提供组织月度代码数据填报接口。

**架构：** 继续使用现有接口和分页逻辑，读取完整数据后在内存中按编号关联、校验，再批量写入 ES。项目事实、特性事实分别存储；月度代码数据由独立接口维护。不新增 MySQL 表。

**技术栈：** Java、现有工程的 ES 客户端和 HTTP/业务框架；ES 7.6 兼容。复用目标工程已有的认证、错误响应、调度、日志和测试设施。

**使用方式：** 本文可以作为邮件附件单独交给内网 AI Agent。开发所需的业务边界、字段来源、mapping 增量、同步规则、接口契约和验收标准均在本文中，不依赖 Git 变更历史、外部聊天记录或其他文档。实施前先定位内网工程中的对应代码，不按本文虚构包名、文件路径或构建命令。

**开发状态：** 内网已建立特性索引，本次保留既有索引和同步成果，不要求回退。研发效能本期的两项耗时按项目统计，使用项目关联特性中最早的审批日期，不读取特性索引；智能化和常规项目分别计算。PM 指标本期不做，已有 PM 字段和数据保留。指标定义见第 9 节，Java 仍只保存事实数据，不预计算耗时。

## 1. 本次交付范围

必须完成：

1. 扩展 `devclaw_project_info` 的 mapping 和完整文档构造。
2. 从 `PUBLIC_PROJECT` 读取开发报工及 PM，保留现有项目字段。
3. 从 `PUBLIC_FEATURE_PROJECT_RELATION` 构建项目与特性关系。
4. 保留已建立的 `devclaw_feature_info` 及其同步，不删除或重建；本期 APP 不依赖该索引。
5. 项目保留范围固定为 `2026-06-01 00:00:00` 及以后立项的全部项目。
6. 新增 `devclaw_org_code_monthly` 及月度组织代码数据填报接口。
7. 提供定向测试、最终 mapping、脱敏文档和接口使用说明。

不属于本次内网 Java 工作：

- 修改 DevClaw APP、页面、图表、Excel 导出或客户端 IPC。
- 判断项目、特性是否智能化，读取 `devclaw_event`、`devclaw_trace`。
- 计算 Token、DevClaw 采纳代码行数、各类比率、工作日耗时或工时分摊。
- 接入节假日 API。2026、2027 年国家工作日历由 DevClaw 侧内置。
- 新增 MySQL、通用数据平台、消息队列或额外的同步锁。
- 修改上游接口的地址、请求和分页方式，修改功能点或柯南问题同步口径。
- 实现 PM 交付特性数，或为本轮指标变更回退已建特性索引、清除已有 PM 数据。

## 2. 当前程序的已有基础

现有 Java 程序负责完整分页读取以下数据，再按项目编号聚合写入 ES：

| 来源 | 当前用途 | 本次处理 |
| --- | --- | --- |
| `PUBLIC_PROJECT` | 项目基本事实 | 补充开发报工、PM；调整数据保留条件 |
| `PUBLIC_FEATURE_PROJECT_RELATION` | 给项目补充特性审批时间 | 同时构建特性事实和项目关联特性编号 |
| 项目功能点接口 | 补充 `notAdjustFuns` | 现有调用、分页、字段和同步逻辑保持不变 |
| 现有柯南问题来源 | 补充非功能问题数及类别 | 现有逻辑保持不变，完整文档写入时保留结果 |

两个 `PUBLIC_*` 接口的请求及分页逻辑已存在，直接复用，不新增逐项目请求。关系接口的业务主键是 `featureCode + prjCode`，一个特性关联多个项目会返回多条记录。

### 2.1 现有项目索引

`devclaw_project_info` 是每个企业项目一条当前事实文档，文档 `_id = prjCode`，现有 mapping 的 `dynamic` 为 `false`。

以下字段已存在，不得按新增字段重复创建或修改其类型：

| 类别 | 已有字段 |
| --- | --- |
| 标识、名称及状态 | `prjCode`、`prjName`、`status`、`phaseStatus`、`type` |
| 组织 | `teamName`、`roomName`、`groupName`、`prjDeptCode` |
| 里程碑 | `createDate`、`firstStStartDate`、`firstStEndDate`、`firstUatStartDate`、`firstUatEndDate`、`firstOnlineDate`、`endDate`、`approvedDate` |
| 项目度量 | `bugNum`、`notAdjustFuns`、`kenanIssueCount`、`kenanIssueCategoryCount` |
| 同步信息 | `syncBatchNo`、`syncedAt` |

`kenanIssueCategoryCount` 为 nested，`notAdjustFuns` 为 scaled_float（scaling_factor=10000）。保留现有完整 mapping，不根据本节字段摘要重建索引。

`centerName` 已出现在项目 `_source` 中，但提供的 mapping 未声明此字段。本次保留现有写入，不以它作为新增统计的过滤或聚合条件，不额外扩大 mapping 改动。

## 3. 项目和特性事实的字段契约

### 3.1 项目文档

| ES 字段 | 来源 | 类型及规则 |
| --- | --- | --- |
| `prjCode` | `PUBLIC_PROJECT.prjCode` | keyword；trim 后作为文档 ID；不改变大小写 |
| `devWorkHours` | `PUBLIC_PROJECT.devCenterWorkhour` | double；累计开发报工小时；非负有限数；允许小数 |
| `pm` | `PUBLIC_PROJECT.pm` | keyword；保存原始“姓名/员工号”形式，去掉首尾空白 |
| `featureCodes` | 关系接口中本项目的 `featureCode` | keyword 数组；trim、去重、稳定排序；无关联时为 `[]` |
| `approvedDate` | 本项目关联特性的 `approvedDate` | 取非空有效日期的最小值；全部为空时写 null |
| 项目日期、组织等 | `PUBLIC_PROJECT` 对应字段 | 沿用现有映射；包括已有的 `firstUatEndDate` |
| `notAdjustFuns` | 原有功能点同步结果 | 保持现有规则，不改用 `PUBLIC_PROJECT.evaluateFp` |
| 非功能问题字段 | 原有同步结果 | 保持现有规则，不清空或丢失 |
| `syncBatchNo`、`syncedAt` | 同步程序 | 两个事实索引共用同一批次标识；时间按 GMT+8 保存 |

开发报工只使用 `devCenterWorkhour`，不使用 `workhour`、`planWorkhour` 或 `testCenterWorkhour` 替代。缺失或 null 保存为 null，明确的 0 保存为 0，不从其他工时字段回退补值。非法数值、负数不能转换为 0 后继续写入。

PM 和项目组织以 `PUBLIC_PROJECT` 为准，不由关系接口的 `pm`、`featureExecuteRoom` 等覆盖。不额外拆分 PM 身份字段，不把它替换为特性负责人 `assigneeCode`。

现有 `bugNum=null` 写为 0 的规则继续保留。不要将该特例套用到新增报工字段。

### 3.2 特性文档

仅同步至少关联一个保留范围内项目的产品特性，不同步未立项需求。

| ES 字段 | 来源 | 规则 |
| --- | --- | --- |
| `featureCode` | 关系接口 `featureCode` | keyword；trim 后作为文档 ID |
| `featureName` | 关系接口 `featureName` | 保存特性名称 |
| `approvedDate` | 关系接口 `approvedDate` | 特性自身的审批完成时间 |
| `syncBatchNo` | 同步程序 | 与本轮项目事实相同 |
| `syncedAt` | 同步程序 | GMT+8 的 `YYYY-MM-DD HH:mm:ss` |

上游保证：同一 `featureCode` 在不同项目记录中的 `approvedDate` 一致。程序按解析后的日期比较；如果实际返回违反此契约，报告冲突并使本轮源数据校验失败，不任取一条或改成最早、最晚值。

项目—特性关系只保存一份：项目文档的 `featureCodes`。特性索引不增加 `prjCodes`、`projectCodes` 等反向项目数组，也不复制项目日期、报工、PM、组织或智能化标记。下游可以批量按项目索引的 keyword 字段 `featureCodes` 反查关联项目，不需要逐特性请求或扫描全部项目。

两个索引中的 `approvedDate` 含义不同，均保留；本期 APP 只使用项目字段：

- 特性字段是该特性自己的审批事实，保留已有同步，不因本期 APP 不读取而删除。
- 项目字段是关联特性最早审批日期的汇总值，供本期两项项目耗时、现有项目级上线耗时及排序使用。
- 两者由同一轮关系数据生成，满足 `项目 approvedDate = min(该项目关联特性的有效 approvedDate)`。不改变项目字段含义，不因新增特性索引删除它。

### 3.3 日期解析和业务范围

- 接受现有上游实际返回的日期和时间，例如 `2026-06-12`、`2026-06-23 11:27:31.0`、`2026-07-03 08:51:34.0`。
- 按 GMT+8 的业务日期时间解释，不根据服务器默认时区转换。
- 日期值补为当天 `00:00:00`；时间解析后去掉小数秒，保存为 `YYYY-MM-DD HH:mm:ss`，不输出 ISO T 格式。
- 沿用已有字段的 ES 日期格式，不改已有字段类型，不修改已有历史日期的时区表达方式。
- 无效的非空日期必须报告，不能作为 null 悄悄跳过。`createDate` 是保留范围判断的必需字段，缺失时不能将该项目直接丢弃后宣称本批成功。
- 按解析后的 `createDate >= 2026-06-01 00:00:00` 筛选主项目。不再使用“距当前六个月”的滚动条件，不添加结束日期上限。
- 特性关系仅写入该范围内已存在的项目，不因关系接口出现未知项目编号而创建项目文档。
- 不自动补存范围外项目。特性关系和日期计算的数据覆盖范围为已保存项目，不承诺完整历史。保留原有孤儿编号告警，并区分已知被日期过滤的项目和主接口未返回的项目。

## 4. ES mapping 变更

先只读核对实际 mapping。项目索引使用增量 mapping，不删除、重建或改变 `dynamic:false`。未明确声明的字段即使出现在 `_source` 中，也不能作为已建立可查询字段处理。

### 4.1 项目索引仅新增三个字段

```http
PUT devclaw_project_info/_mapping
```

```json
{
  "properties": {
    "devWorkHours": { "type": "double" },
    "pm": { "type": "keyword" },
    "featureCodes": { "type": "keyword" }
  }
}
```

`featureCodes` 存字符串数组，不需要 nested。`firstUatEndDate`、`teamName` 已存在，只补充读取和构造文档，不新增相同字段的 mapping。

### 4.2 新增特性索引

```http
PUT devclaw_feature_info
```

```json
{
  "mappings": {
    "dynamic": false,
    "properties": {
      "featureCode": { "type": "keyword" },
      "featureName": { "type": "keyword" },
      "approvedDate": {
        "type": "date",
        "format": "yyyy-MM-dd HH:mm:ss||epoch_millis"
      },
      "syncBatchNo": { "type": "keyword" },
      "syncedAt": {
        "type": "date",
        "format": "yyyy-MM-dd HH:mm:ss||epoch_millis"
      }
    }
  }
}
```

索引分片、副本、连接和认证使用目标工程已有约定；这里不写死集群容量参数。若新索引已存在，核对 mapping 后复用，不重建。已有同名字段类型冲突时报告差异，不在本次自动实施迁移适配。

## 5. 同步处理流程

### 5.1 复用与新增的处理顺序

1. 沿用现有定时入口和避免任务重叠的运行方式，生成本轮 `syncBatchNo`、`syncedAt`。不引入新锁、队列或并行调度。
2. 按现有请求和分页方式完整读取 `PUBLIC_PROJECT`，先完成分页完整性检查。按创建时间筛选保留项目，构建 `Map<prjCode, ProjectFactBuilder>`。
3. 在已有项目字段构造上增加 `devWorkHours`、`pm`，初始化每个项目的 `featureCodes` 集合和项目级 `approvedDate` 最小值。
4. 按现有请求和分页方式完整读取 `PUBLIC_FEATURE_PROJECT_RELATION`。只对主项目 Map 中存在的项目应用关系。不要额外增加会截断关系的新日期条件。
5. 对每条有效关系：项目的特性集合加入 `featureCode`；项目级 `approvedDate` 更新为最早有效审批时间；按 `featureCode` 构建特性 Map。
6. 保留原有功能点、柯南问题数及类别补充逻辑。
7. 所有来源读取完整，日期、编号、数值和关系校验成功后，构造最终文档。
8. 项目文档以 `_id=prjCode`，特性文档以 `_id=featureCode`，使用现有 Bulk 完整覆盖写入方式，分批写入两个索引。复用现有批量大小和失败项重试逻辑。
9. 两个事实索引本轮全部写入成功后，才分别执行现有批次清理方式，清理各自非本批次的旧事实文档。任何读取、校验或写入失败，都不得执行这轮旧文档清理。

月度索引由填报接口独立维护，绝不能被事实同步任务按 `syncBatchNo` 清理。

### 5.2 关联规则

```text
projectMap[prjCode].featureCodes.add(featureCode)
projectMap[prjCode].approvedDate = min(该项目全部非空特性审批日期)
featureMap[featureCode] = 特性编号、名称、特性审批日期、同步信息
```

不需要长期保留关系接口全部原始响应；每页处理后释放。使用项目特性集合和特性 Map 完成归并，不创建完整的额外关系 List，不为每个项目或特性重新请求接口。

### 5.3 覆盖写入和失败边界

项目文档构造必须基于现有完整 Builder 扩展，不得只写新增三个字段而覆盖掉已有日期、功能点或柯南问题字段。

当 PM、报工变为空，或者某个特性关系已从本轮完整数据中移除时，覆盖写入应清除旧值或旧数组项，不与上一批次数组取并集。

全部读取和校验应在第一次 Bulk 前完成。两个索引不是事务性切换，写入期间可能短暂读到不同批次；本次接受这一边界，不新增版本索引、别名切换或事务协调。两边使用同一批次号便于排查，完成整轮写入后再清理旧文档。

沿用已有旧文档清理机制，并将成功条件扩展为两个事实索引均成功，不新增无条件删库或全索引重建步骤。迁移后第一次成功的完整同步应回填全部保留项目，而不是仅同步当天变化的项目。

## 6. 脱敏数据示例

以下只展示本次相关字段，不是覆盖现有项目文档时使用的完整字段白名单。

```json
{
  "prjCode": "T26DEMO01",
  "createDate": "2026-06-12 00:00:00",
  "pm": "示例甲/80000001",
  "teamName": "示例开发团队",
  "roomName": "A室",
  "devWorkHours": 17.0,
  "featureCodes": ["BU-DEMO-F01", "BU-DEMO-F02"],
  "approvedDate": "2026-06-10 08:00:00",
  "firstStStartDate": "2026-06-23 11:27:31",
  "firstStEndDate": "2026-06-23 14:06:12",
  "firstUatStartDate": "2026-06-24 11:44:57",
  "firstUatEndDate": "2026-06-24 18:59:58",
  "firstOnlineDate": "2026-06-24 00:00:00",
  "syncBatchNo": "example-batch-01",
  "syncedAt": "2026-11-15 05:00:03"
}
```

```json
{
  "featureCode": "BU-DEMO-F01",
  "featureName": "示例产品特性",
  "approvedDate": "2026-06-10 08:00:00",
  "syncBatchNo": "example-batch-01",
  "syncedAt": "2026-11-15 05:00:03"
}
```

## 7. 月度代码汇总索引

### 7.1 业务契约

外部系统可按组织、月份、来源筛选，取得对应来源 AI 入库行数和该组织当月总入库行数。人工通过 Java 接口填报，默认维护上月，允许历史补录修正。

每个组织通过 `metrics` 对象填报指标，允许的键为 `total`、`devagent`、`devagent-cloud`、`devagent-cli`。`total` 表示组织当月全部入库行数，是共同分母；其他三项表示各渠道入库行数。四项可以一起或分别填报。DevClaw 分子由 APP 复用运营面板“入库采纳率”的已 Push 采纳行数，不允许在此接口手填。

只支持自然月，不设计近 14 天、近 30 天或任意起止日期。`month` 是 `YYYY-MM` 的月份标识，不是保存时间字段。月份边界由月份推算，无需人工填写开始、结束时间。

### 7.2 文档和唯一标识

每个“月份 + 组织层级 + 团队 + 室”一条文档，各指标使用固定字段保存，不按指标拆成多条文档。请求的 `metrics` 对象由 Java 映射到这些字段，不直接作为 ES 新字段写入。

- `orgLevel=team`：`teamName` 必填，`roomName=null`。
- `orgLevel=room`：`teamName`、`roomName` 都必填。
- 名称使用与项目事实、APP 组织字典一致的名称，只 trim，不做模糊匹配或别名推断。
- 当前无需提供组织编码，使用上述组织组合确定身份；不凭空增加上游不存在的组织编号。
- `_id` 使用上述四个字段的确定性标识。建议对 UTF-8 编码的紧凑 JSON 数组 `[month,orgLevel,teamName,roomName]` 计算 SHA-256 并输出小写十六进制；字段顺序固定、无额外空格、中文不转义、团队 roomName 固定为 null。同一规则用于所有填报请求，重复提交必须命中同一文档。
- 只存整数原始行数，不存计算后的百分比，不存手填的 DevClaw 行数。

### 7.3 Mapping

```http
PUT devclaw_org_code_monthly
```

```json
{
  "mappings": {
    "dynamic": false,
    "properties": {
      "month": { "type": "keyword" },
      "orgLevel": { "type": "keyword" },
      "teamName": { "type": "keyword" },
      "roomName": { "type": "keyword" },
      "totalPushedLines": { "type": "long" },
      "devagentIdePushedLines": { "type": "long" },
      "devagentCloudPushedLines": { "type": "long" },
      "devagentCliPushedLines": { "type": "long" },
      "updatedBy": { "type": "keyword" },
      "updatedAt": {
        "type": "date",
        "format": "yyyy-MM-dd HH:mm:ss||epoch_millis"
      }
    }
  }
}
```

未填报的总行数或来源计数保留缺失或 null，不能默认初始化为 0。明确填报 0 才表示对应计数当月为零。

已有月度索引先核对实际 mapping，确保存在目标字段 `devagentIdePushedLines`，并同步修改 Java 写入和 APP 读取。历史字段和数据的迁移另行确认，本次不自动增加双写、字段别名或数据转换。

## 8. 月度填报接口

### 8.1 路由和请求

建议新增 `POST /devclaw/org-code-monthly/report`，若已有内网服务采用统一路由前缀，按现有规范落位并在交付说明中给出最终路径。复用已有维护接口的认证和业务响应格式，不新建独立服务或额外维护页面。

```json
{
  "month": "2026-10",
  "items": [
    {
      "orgLevel": "team",
      "teamName": "示例开发团队",
      "roomName": null,
      "metrics": {
        "total": 560121,
        "devagent-cloud": 125841
      }
    },
    {
      "orgLevel": "room",
      "teamName": "示例开发团队",
      "roomName": "A室",
      "metrics": {
        "total": 12602,
        "devagent-cli": 706
      }
    }
  ]
}
```

每个 item 表示一个组织，同一请求中每个组织只出现一次。`metrics` 允许只包含 `total`、只包含某一渠道，或包含多个指标；未提交指标保留原值，总行数与来源计数没有填报先后要求。示例不表示团队只有 cloud 数据或 A 室只有 cli 数据。

`month` 可省略，按 GMT+8 当前日期推算上一个自然月。显式提供时严格校验 `YYYY-MM`。其余上述必需字段不得省略。`updatedBy` 从现有已认证维护身份取得，不依赖客户端任意填写；`updatedAt` 由服务端按 GMT+8 生成。

### 8.2 更新规则

| metrics 中的键 | 对应 ES 字段 |
| --- | --- |
| `total` | `totalPushedLines` |
| `devagent` | `devagentIdePushedLines` |
| `devagent-cloud` | `devagentCloudPushedLines` |
| `devagent-cli` | `devagentCliPushedLines` |

1. 请求整体先完成字段校验，不因一条非法记录而写入其他合法记录。
2. 每个 item 的 `metrics` 必须是非空对象，键仅允许上表四项。每个值必须是非负整数，以数字提交，不接受 `"560,121"`、百分比、浮点小数、负数或 null。
3. 同一请求内重复的“月份 + 组织层级 + 团队 + 室”拒绝；判重使用与文档 ID 相同的组织规范化规则，不合并重复 item 或累加计数。
4. 使用现有 ES 客户端的局部更新/upsert。每个 item 将 `metrics` 中明确提交的指标映射到对应 ES 字段，并更新维护信息；重复请求覆盖、不累加。未提交的总行数和其他渠道计数保留原值，新文档也不为缺失指标填 0。文档唯一标识只包含月份和组织。
5. 仅 `metrics.total` 可以更新 `totalPushedLines`，它是该组织当月各渠道 AI 编码占比的共同分母，包括 DevClaw AI 编码占比。它不参与 DevClaw“AI 代码入库率”的计算。修正总行数不改变其他来源计数，但下游各渠道占比使用更新后的分母。先填来源、后填总行数时，保留来源值，分母缺失期间不计算占比。
6. 不校验三个 AI 来源行数之和必须等于或小于组织总行数，本期不处理跨来源重叠和行数定义对齐。
7. 多文档写入不承诺事务性。发生写入失败必须返回失败或部分失败及可定位的条目，不能返回全部成功；使用相同标识重试即可覆盖，不增加回滚、锁或队列。
8. 返回至少包含实际月份、成功更新的组织文档数量、成功写入的指标数量（包含 total）及失败组织条目。一个组织有多个指标时，组织数量计 1，指标数量按其 `metrics` 键数计算。外层状态码和错误格式复用目标工程，交付最终响应样例。

`metrics` 不接受 `devclaw` 或任何未知键。更新不清除未提及的计数，也不提供历史删除或审计表。本次不新增月度数据查询接口，APP 后续按已有 ES 只读方式查询该索引。

### 8.3 月度数据的消费约束

这些规则用于避免 Java 写入内容与 APP 查询不一致，不要求内网实现 APP 计算：

- 全团队查询直接使用团队文档，不与下属室文档相加。
- 单室查询使用该室文档。多选室时，仅累加选中室的分子和分母，不平均比例，不混入团队文档。
- 所选任一室缺少总行数或目标来源数据时，该组合比例不能按缺失为 0 生成完整结果。
- 某月无记录表示未维护，不表示所有行数为 0。总行数为 0 时没有有效占比。
- 自然月区间为月初 `00:00:00` 到次月月初 `00:00:00`，左闭右开。
- APP 复用研发效能看板的时间选择：只有选择自然月时展示 AI 编码占比；非自然月范围不展示，并通过 Tips 说明“AI 编码占比仅支持自然月数据”。不要求额外的独立月份选择器，也不将任意周期折算成月度结果。

## 9. 下游计算边界

本次 Java 只交付事实数据。本节明确数据消费方式，不要求内网实现指标，也不为这些结果增加索引字段。

### 9.1 本次确认的指标口径

| 指标 | 口径及使用字段 |
| --- | --- |
| 智能化特性占比 | 先按所选组织、项目日期口径及周期筛选项目，只把这些项目关联的特性纳入候选集合，再按 `featureCode` 去重；分母为候选特性总数。候选特性只要有一个已保存关联项目智能化，就属于智能化特性，否则属于非智能化特性。候选集合受周期限制，分类仍查看该特性全部已保存关联项目，不限当前室或周期 |
| DevClaw AI 编码占比 | 仅在看板选择自然月时展示。分子直接复用运营面板“入库采纳率”的已 Push 采纳行数 `pushedAdoptedLines`；分母为同一组织、月份的 `totalPushedLines`，不手填 DevClaw 分子 |
| 智能化／常规项目审批完成到开发完成平均时长 | 按 `prjCode` 去重，智能化和常规项目分别统计。每个项目使用自身 `approvedDate`，即其全部关联特性中最早的有效审批日期；完成时间取该项目 `firstStStartDate`，缺失才取 `firstUatStartDate`。完成时间减项目 `approvedDate`，逐项目计算工作日耗时后求有效项目平均值 |
| 智能化／常规项目等待时长 | 按 `prjCode` 去重，智能化和常规项目分别统计。每个项目用 `createDate` 减自身 `approvedDate`，逐项目计算工作日耗时后求有效项目平均值，不按特性编号去重或跨项目取最早日期 |
| AI 代码入库率 | 直接复用运营面板“入库采纳率” `pushedAdoptionRate`，即 `pushedAdoptedLines / pushedEffectiveGeneratedLines`，限定 `projectFromLean=true` 且排除两个测试标记对应的 Harness 项目。复用公式和统计逻辑不代表沿用未经范围过滤的页面结果；不另设分母，不使用组织月度总行数，也不替换成“总量入库采纳率” `inclusivePushedAdoptionRate` |

两个 DevClaw 代码指标复用同一组织、周期及精益非测试范围内的现有统计。时间过滤也复用现有采纳统计路径，当前代码按 `properties.generatedAt` 选取采纳事件，再要求 `pushed=true`，不另建按 `pushedAt` 过滤的分子。Java 无需读取或改造这些事件。

两项耗时每个项目只产生一个结果。一个特性关联多个项目时，各项目分别计算；一个项目关联多个特性时，使用最早审批日期，只计一次项目。缺少有效起止日期或日期顺序异常时不能填 0 参与平均。无需读取 `devclaw_feature_info`。

筛选项的展示名称为“开发完成”，默认时间条件仍为 ST 结束日期，缺失才取 UAT 结束日期；耗时终点沿用首次 ST 发起、缺失取首次 UAT 发起。这是两个不同用途的日期规则，不能因名称一致而在 Java 合并或替换原始字段。

PM 交付特性数不在本期 APP 范围内，不增加对应查询、页面或导出列；保留内网已有 PM 数据。

### 9.2 原始数据保留要求

- 智能化分类由 APP 使用精益、非测试 Harness 快照计算，统一排除 `isTestProject=true` 或 `manuallyMarkedTestProject=true`。内网不写分类字段。
- 特性占比和项目特性吞吐率需要原始 `featureCodes`；不能提前按室或智能化类型汇总，或将关系展开后重复累加项目报工。
- 项目是否已上线由有效 `firstOnlineDate` 判断。报工保留小时原值；1 人月为 152.25 小时，由 APP 换算，不在 Java 分摊工时。
- 周期筛选由 APP 执行：支持“立项时间”和“开发完成”；默认“开发完成”使用 ST 结束时间，只有 ST 结束为空才用 UAT 结束。Java 不能因此只保存已上线或结束测试的项目。
- 项目的 ST、UAT 开始和结束日期分别保存，不能合并成一个字段。项目 `approvedDate` 保持最早关联特性审批日期的规则；特性索引保留自己的审批事实，但本期 APP 不读取。
- 其他耗时、项目上线耗时和日期排序均由 APP 处理。Java 不新增特性级最早/最晚立项、测试、上线日期或耗时字段，不删除已有原始字段。关系接口的 `firstInPrjDate`、`lastOnlineTime`、特性 `onlineDate`、`featureStatus` 不替代项目日期。
- APP 使用内置 2026、2027 年国家工作日历计算所有耗时，扣除非工作日覆盖时间、按 24 小时折算并保留小数；7 小时只参与报工的人月换算。

## 10. 实施任务和验收

### 任务 1：定位现有实现并检查索引

定位现有主接口 DTO、关系 DTO、项目 Builder、功能点/柯南补充过程、Bulk 写入与清理入口、维护接口和相关测试。记录实际拟修改文件清单。只读检查三个索引的实际 mapping，按第 4、7 节补充，保留已有类型和数据。

### 任务 2：扩展项目 DTO 和文档构造

增加开发报工、PM、特性集合；确保已有 UAT 结束时间继续写入。将保留条件改为固定起点。复用已有日期处理并覆盖上游 `.0` 时间格式，补充报工 null/0、小数及非法值测试。

### 任务 3：扩展关系聚合和特性写入

一轮完整关系拉取同时完成项目特性集合、项目最早审批时间和特性 Map。新增特性 Builder/文档，不复制项目事实。两个事实索引使用相同批次，完整输入校验后分批写入，全部成功后清理。复用项目既有写入、重试和清理方法，避免复制一套不同的同步框架。

### 任务 4：实现月度填报

按第 8 节接入现有 Java 服务，完成校验、月份计算、确定性文档 ID 和局部更新；不增加 MySQL 或页面。提供可直接提交的请求示例和响应说明。

### 任务 5：定向验证

使用目标工程已有命令，只验证本次相关代码；不要全项目格式化、运行 lint --fix 或修改无关文件。至少覆盖以下场景：

| 场景 | 预期 |
| --- | --- |
| `createDate=2026-06-01` | 保留；保存为当天零点 |
| `createDate=2026-05-31` | 不进入项目索引本轮集合 |
| `devCenterWorkhour=17`，同时存在其他工时字段 | `devWorkHours=17`，不使用总工时或测试工时 |
| 开发报工为小数、0、null | 分别保留，不互相转换 |
| 开发报工为负数或非法字符串 | 源数据校验失败，不假填 0 |
| 项目 PM 与关系 PM 不同 | 使用 `PUBLIC_PROJECT.pm` |
| 一个项目只关联一个特性 | 特性数组一个编号，项目与特性审批日期一致 |
| 一个项目关联两个不同审批日期的特性 | 两个特性各保存自己的日期；项目保存最早日期 |
| 一个特性关联两个不同室的项目 | 一个特性文档，两个项目均保留关系；特性无反向项目数组或唯一责任室 |
| 项目 ST/UAT 发起和结束日期均不同 | 原值分别保留，不取最早/最晚后覆盖，也不预计算开发完成时间 |
| 同一个特性审批日期冲突 | 本轮读取校验失败，两个事实索引均不开始本轮写入 |
| 重复相同关系 | 特性数组去重，项目不重复，分页完整性校验不被去重条数干扰 |
| 关系本轮移除或字段变 null | 覆盖写入清除旧关系/旧值 |
| 项目完整覆盖写入 | 现有功能点、柯南数、类别、里程碑等均保留 |
| 任一来源分页失败 | 两个事实索引均不开始本轮写入，不清理旧数据 |
| 特性 Bulk 写入最终失败 | 不清理两个事实索引旧批次，返回失败，重试不产生重复文档 |
| 重复请求提交同一组织指标 | 覆盖，不累加 |
| 先填 devagent-cloud，后填 devagent-cli | 同一组织月份记录保留两个来源计数 |
| 先填来源，后填 total | 首次保留来源，总行数缺失；随后补齐分母且来源不变 |
| 先填 total，后填来源 | 只增加对应来源计数，总行数保留 |
| 单独修正 total | 只修改总行数，各来源计数保留；下游使用新分母 |
| metrics.devagent=100 | 写入 devagentIdePushedLines=100；请求键仍为 devagent |
| 未填 devagent | devagentIdePushedLines 缺失或 null，不自动为 0 |
| 团队 devagent-cloud=125841，总量=560121 | 正确保存整数；下游占比约 22.47% |
| A 室 devagent-cli=706，总量=12602 | 正确保存为 devagent-cli；下游占比约 5.60% |
| 月度默认月份，当前为 2026-11 | 保存月份为 `2026-10` |
| metrics 缺失、为 null、为空对象或包含 devclaw/未知键 | 请求校验失败且不开始写入 |
| 缺组织、指标值为 null、逗号字符串、负数、小数行数 | 请求校验失败且不开始写入 |
| 同请求同一组织出现两次，即使 metrics 不同 | 请求校验失败 |
| 同一 item 的 metrics 包含 total、devagent-cloud、devagent-cli | 更新同一组织月份文档三个字段，组织数量计 1、指标数量计 3 |
| 重跑项目同步与旧事实清理 | 不影响任何月度记录 |

不要求运行外网浏览器、搭建临时页面或 UI 截图验收。性能检查复用内网数据和测试设施，至少记录项目数、关系行数、去重特性数、每轮耗时及堆内存；不将原始全量响应和全部 Bulk 文档同时长期保存在内存。

## 11. 交付清单

1. 实际改动文件、所用构建及定向测试命令和结果。
2. 项目 mapping 增量，以及特性、月度索引最终 mapping。
3. 完整同步结果：读取条数、日期过滤数量、有效项目数、有效关系数、特性数、批次号、同步时间和异常统计。
4. 脱敏项目和特性文档，至少覆盖跨室特性与一个项目多特性。
5. 月度填报最终路由、认证接入方式、请求及成功/错误/部分写入失败响应样例、来源分别填报的使用步骤。
6. 两个新索引及原项目索引面向 DevClaw 的只读访问配置说明。
7. 明确哪些仅完成代码和测试，哪些已经实际建索引、回填或部署；没有执行的操作不得写成已完成。

本文定义开发目标，不表示已操作内网索引、完成迁移或部署。DevClaw 查询、完整分页、分类缓存、工作日计算、页面和导出由后续客户端计划负责，不在本次 Java 交付中扩展。
