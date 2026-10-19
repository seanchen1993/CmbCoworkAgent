# Commit 文件级 Agent 代码行上报设计

> 状态：已实现。
> 目的：把每个 commit 里每个文件由 Agent 生成的代码行（行数和行号）写进 ES，后续从 ES 拉取后上报码云平台。
> 行数口径沿用 [Agent 有效生成行数与采纳率计算口径](./Agent有效生成行数与采纳率计算口径.md)，本文只新增文件粒度和行号。

## 1. 现状

| 数据                             | 粒度                                                  | 文件路径                             | 行号                                                         |
| -------------------------------- | ----------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `git.commit.created`             | 一个 commit 一条                                      | 没有，只有整次提交的文件数、增删行数 | 没有                                                         |
| `code_adopt`                     | Agent 每次 write_file / edit_file 一条，commit 时测量 | 没有                                 | 没有                                                         |
| `code_gen`                       | 同上，生成时上报                                      | 只有文件名                           | 没有                                                         |
| 本机 sqlite `adopt_line_details` | 每次生成一条                                          | 有，仓库相对路径                     | 只有生成内容里的序号，不是提交后文件的行号；留 14 天，不上云 |

按 `commitSha` 加总 `code_adopt.adoptedLineCount` 能得到一个 commit 的 Agent 行数，但拆不到文件，也不知道是哪几行。

## 2. 已确认的约束

| 项           | 结论                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| 粒度         | 行数和行号都要                                                                          |
| 行数口径     | 与现有采纳率口径一致，不改算法                                                          |
| 空行         | 按现有口径，不计入                                                                      |
| 统计范围     | 不动：只算 write_file / edit_file；代码文件白名单；测试文件仍走 `code_test_gen`，不计入 |
| commit 标识  | 按 commit SHA                                                                           |
| 推送状态     | 不改后端，取数时按 commitSha 关联已有事件上的 `pushed`                                  |
| 文件路径上云 | 可以，上传仓库内相对路径                                                                |
| 历史数据     | 不补，新版本发布后开始有                                                                |

## 3. 方案概述

新增事件 `code_commit_file`，一个 commit 里的一个文件一条。它由现有的 commit 测量任务产生，和这个文件的 `code_adopt` 在同一个本地事务里写入发件队列，再走现有上报通道进 ES。

```text
git commit（面板提交 / 自动提交 / 终端或 IDE 经 hook / reflog 兜底）
  → measureForCommit → commit 测量任务（已有）
      → 逐文件测量，产生 code_adopt（已有）
      → 同一文件汇总行数，定出行号，产生 code_commit_file（新增）
      → 同一个 SQLite 事务写入发件队列（已有机制）
  → 上报 /api/traces/events → ES
```

四种提交入口最后都进同一个测量任务，所以不用分别改。后端、ES 映射、看板都不用改。

## 4. 事件定义

### 4.1 什么时候发

commit 测量时，某个文件只要写出了至少一条 `code_adopt`，就为这个文件发一条 `code_commit_file`。因此：

- 本次提交里没有 Agent 生成记录的文件没有这条事件，取数时按 0 处理。
- Agent 生成的内容一行都没进提交的文件也有一条，`agentLineCount` 为 0。
- 本次提交删除的文件也有一条，`fileDeleted` 为 true，没有行号。

后两种是为了让同一 commit 的 `code_commit_file` 加起来正好等于它的 `code_adopt` 加起来，见第 5 节。

### 4.2 字段

事件信封沿用现有格式：`eventName` 为 `code_commit_file`，`eventCategory` 为 `code_adoption`，自带 `eventTime`、`userName`、`sapId`、`orgName`、`pathName`、`upperOrgLv0` 到 `upperOrgLv3` 等身份字段。`properties` 如下：

| 字段                          | 类型           | 说明                                                                                          |
| ----------------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| `schemaVersion`               | number         | 固定 1                                                                                        |
| `commitSha`                   | string         | 完整 SHA                                                                                      |
| `filePath`                    | string         | 仓库根目录下的相对路径，`/` 分隔                                                              |
| `language`                    | string         | 文件扩展名，如 `java`、`ts`                                                                   |
| `fileDeleted`                 | boolean        | 本次提交删除了该文件                                                                          |
| `agentLineCount`              | number         | Agent 生成且进入本次提交的行数，等于该文件本次 `code_adopt.adoptedLineCount` 之和             |
| `agentLineRanges`             | string[]       | 这些行在提交后文件里的行号，1 起算，升序，每段写成 `起-止`，单行也写成 `45-45`                |
| `agentLineRangesTruncated`    | boolean        | 段数超过 5000 时截断，`agentLineCount` 仍然准确                                               |
| `lineMapping`                 | string         | `diff`：行号参考了本次提交的 diff；`file_order`：没拿到 diff，只按文件内容定                  |
| `agentLineCountOutsideDiff`   | number \| null | 行号落在本次提交未改动行上的行数，正常为 0；`file_order` 时为 null                            |
| `generatedLineCount`          | number         | 该文件本次 `code_adopt.generatedLineCount` 之和                                               |
| `effectiveGeneratedLineCount` | number         | 该文件本次 `code_adopt.effectiveGeneratedLineCount` 之和                                      |
| `addedLineCount`              | number \| null | 本次提交该文件新增行数，和 `git show --numstat` 一致，含空行；没拿到 diff 时为 null           |
| `addedNonBlankLineCount`      | number \| null | 其中非空行数                                                                                  |
| `deletedLineCount`            | number \| null | 本次提交该文件删除行数                                                                        |
| `genEventIds`                 | string[]       | 汇总进来的 `code_adopt` 对应的生成事件 ID，可关联 `code_gen.eventId`、`code_adopt.genEventId` |
| `measuredAt`                  | string         | 测量时间，ISO 格式                                                                            |

不上传代码内容，不上传本机绝对路径。

`agentLineRanges` 的每一段只包含计入的行，空行会把区间断开，所以各段长度相加等于 `agentLineCount`，截断时除外。单行也写成 `45-45`，是为了避免 ES 动态映射把 `2026` 这类纯数字字符串识别成日期。

### 4.3 示例

```json
{
  "eventName": "code_commit_file",
  "eventCategory": "code_adoption",
  "eventTime": "2026-10-09T15:21:07.412+08:00",
  "userName": "...",
  "sapId": "...",
  "properties": {
    "schemaVersion": 1,
    "commitSha": "4be2c1f0d3a94e0b9a61c7de8f2b5a0c9d1e7f36",
    "filePath": "order-service/src/main/java/com/example/order/OrderService.java",
    "language": "java",
    "fileDeleted": false,
    "agentLineCount": 22,
    "agentLineRanges": ["41-49", "51-58", "73-77"],
    "agentLineRangesTruncated": false,
    "lineMapping": "diff",
    "agentLineCountOutsideDiff": 0,
    "generatedLineCount": 26,
    "effectiveGeneratedLineCount": 25,
    "addedLineCount": 31,
    "addedNonBlankLineCount": 27,
    "deletedLineCount": 4,
    "genEventIds": ["g_1b0e...", "g_7c42..."],
    "measuredAt": "2026-10-09T07:21:07.388Z"
  }
}
```

## 5. 行数口径

行数完全沿用现有算法：归一化非空行、多重集匹配、Agent 自我修订扣分母、拿 Agent 生成行去匹配提交后的整个文件。新事件只是把同一文件本次写出的 `code_adopt` 加总：

```text
agentLineCount              = Σ adoptedLineCount
effectiveGeneratedLineCount = Σ effectiveGeneratedLineCount
generatedLineCount          = Σ generatedLineCount
```

求和只算 `adoptedLineCount` 不为空的 `code_adopt`，和看板按 commit 汇总采纳行数时的过滤条件一致。所以对任意 commit 都有：

```text
Σ code_commit_file.agentLineCount（该 commit）= Σ code_adopt.adoptedLineCount（该 commit）
```

这条等式也是实现后的自测项。

## 6. 行号怎么定

### 6.1 问题

现有算法只算出"某种内容有几行被采纳"，不记录是哪一行。比如 Agent 生成了一个 `}`，提交后的文件里有 5 个 `}`，算法只知道其中 1 个算 Agent 的。行数口径不能改，所以行号只能在这个数量之内挑位置。

### 6.2 规则

对每一种内容，按下面的顺序挑出和采纳数量相同的行：

1. 先从本次提交新增的行里挑。新增行来自 `git diff-tree` 和父提交的比较，merge commit 和第一个父提交比较。
2. 候选行不多于需要的数量，全部选上。
3. 候选行多于需要的数量，常见于 `}`、`return null;` 这类重复内容，选离已确定的 Agent 行最近的；距离相同选靠前的。Agent 写的代码通常连成一片，这样能把 `}` 落到 Agent 那段代码旁边。
4. 新增行不够时，剩下的从未改动的行里按同样规则挑，并计入 `agentLineCountOutsideDiff`。这种情况是 Agent 的那行没进提交，但文件别处恰好有一模一样的旧行，现有算法也会把它算作采纳。
5. 拿不到 diff 时，比如 git 失败、超时或文件被当成二进制，不区分新增和未改动，整个文件按第 2、3 条挑，`lineMapping` 记为 `file_order`。

这套规则只决定行号落在哪里，不改变任何行数。

### 6.3 例子

提交后的文件片段：

```text
10  public void a() {        旧代码
11  }                        旧代码
...
40  public void b() {        本次新增，Agent 生成
41      doB();               本次新增，Agent 生成
42  }                        本次新增，Agent 生成
...
60  public void c() {        本次新增，人工编写
61      doC();               本次新增，人工编写
62  }                        本次新增，人工编写
```

现有算法算出 3 行采纳，其中一行是 `}`。只按文件顺序挑会选到第 11 行。按本规则：第 11 行不是新增行，先排除；新增行里第 42 行和第 62 行都是 `}`，第 40、41 行已确定是 Agent 行，第 42 行离得最近，所以行号是 `40-42`。

### 6.4 diff 的取法

```text
git -c core.quotePath=false --literal-pathspecs diff-tree -r -p --unified=0 --no-color --no-ext-diff
    --no-renames --src-prefix=a/ --dst-prefix=b/ <sha>^1 <sha> -- <本次有生成记录的文件>
```

根提交没有父提交，改用 `--root <sha>`。只解析 `+++` 文件头和 `@@ -a,b +c,d @@` 块头，新增行就是第 c 行到第 c+d-1 行。不做重命名识别，本次提交里被重命名的文件会整份算新增，行号退化为在整个文件里挑。

## 7. 可靠性与性能

- **事务**：`code_commit_file` 和同一文件的 `code_adopt` 在同一个 SQLite 事务里写入。如果文件里某条生成记录在事务提交前已被别处测量（并发提交或 Agent 删除文件），整个测量任务回滚，按现有退避重试，保证汇总值和实际写出的 `code_adopt` 一致。现在的做法是跳过那条记录、其余照常写入，这是唯一改变的既有行为。
- **上报**：沿用现有发件队列，失败自动重试，1 天内最多 10 次。离线超过 1 天的事件不再上传，和 `code_adopt` 现有行为相同。
- **git 调用**：每个测量任务最多多一次 `git diff-tree`，只带本次有生成记录的文件；异步执行，超时 5 秒，输出上限 8MB。失败降级为 `file_order`，不影响行数，也不影响 `code_adopt`。
- **实测 git 调用**：
  - 设计时在本仓库测，取 5 次中位数，没有限定文件，所以数字偏大：普通 commit（9 到 45 个文件，补丁 43 到 216KB）11 到 20ms；merge commit 和第一个父提交比较（补丁 160 到 645KB）20 到 44ms。
  - 实现后端到端测试里的实际调用：11 到 13ms；根提交要先失败一次再按创建处理，20ms。
  - 每次调用都会打日志 `[AdoptionTracker] commit diff: ... durationMs=`，线上可以直接看真实耗时。
- **提交耗时**：面板内提交和自动提交都会等测量任务完成才返回，所以提交会多出上面这一次 git 调用的时间。
- **实测行号计算**（7 次取中位数）：
  - 2000 行文件：建行号索引 0.56ms，和原来只算哈希的 0.57ms 持平；挑行号 0.23ms。
  - 2 万行文件（单次生成的上限），8750 行被采纳：建行号索引 3.4ms，挑行号 2.6ms，压缩区间 0.2ms。
  - 最坏情况，2 万行文件里的 `}` 全部需要按距离挑：4.7ms。

## 8. 从 ES 取数

索引是 `devclaw_event`，对应客户端配置 `VITE_ES_INDEX_EVENT`。

### 8.1 取文件明细

```json
POST devclaw_event/_search
{
  "size": 1000,
  "query": {
    "bool": {
      "filter": [
        { "term": { "eventName": "code_commit_file" } },
        {
          "range": {
            "eventTime": { "gte": "2026-10-01T00:00:00+08:00", "lt": "2026-10-08T00:00:00+08:00" }
          }
        }
      ]
    }
  },
  "_source": [
    "eventTime",
    "userName",
    "sapId",
    "properties.commitSha",
    "properties.filePath",
    "properties.fileDeleted",
    "properties.agentLineCount",
    "properties.agentLineRanges",
    "properties.agentLineRangesTruncated",
    "properties.lineMapping",
    "properties.agentLineCountOutsideDiff",
    "properties.addedLineCount",
    "properties.addedNonBlankLineCount"
  ]
}
```

数据量大时用 scroll 或 search_after 分页。`eventTime` 是测量时间，一般在提交后几秒内；经 reflog 兜底补测的提交，可能要等应用下次启动才有这条事件。

### 8.2 判断是否已推送、取仓库信息

推送后，现有机制会给同一 SHA 的 `code_adopt` 和 `git.commit.created` 写上 `pushed`、`pushedAt`、`remoteUrl`、`repositoryFullName`、`commitUrl` 等字段。建议按 `code_adopt` 关联：它走可靠的发件队列，而 `git.commit.created` 是即发即弃，偶尔会丢；每条 `code_commit_file` 在同一 SHA 下一定有 `code_adopt`。

```json
POST devclaw_event/_search
{
  "size": 0,
  "query": {
    "bool": {
      "filter": [
        { "term": { "eventName": "code_adopt" } },
        { "term": { "properties.pushed": true } },
        { "terms": { "properties.commitSha": ["<sha1>", "<sha2>"] } }
      ]
    }
  },
  "aggs": {
    "by_commit": {
      "terms": { "field": "properties.commitSha", "size": 1000 },
      "aggs": {
        "push": {
          "top_hits": {
            "size": 1,
            "_source": [
              "properties.pushedAt",
              "properties.remoteUrl",
              "properties.repositoryFullName",
              "properties.repositoryWebUrl",
              "properties.commitUrl"
            ]
          }
        }
      }
    }
  }
}
```

有桶的 SHA 就是已推送的 commit。

### 8.3 拉取脚本要处理的事

- 按 `(commitSha, filePath)` 去重，保留 `eventTime` 最新的一条。正常不会重复，只是保险。
- 展开行号：`41-49` 就是第 41 到 49 行，共 9 行。
- 上传码云时跳过 `agentLineCount` 为 0 或 `fileDeleted` 为 true 的记录。
- `agentLineCountOutsideDiff` 大于 0 表示有行号落在本次未改动的行上。如果码云要求 AI 行必须是本次改动的行，可以丢掉这部分行号，但上传的行数会因此和看板对不上，需要在拉取侧决定。
- 没有记录的 commit 和文件按 0 处理。

## 9. 已知限制

- 只统计 write_file / edit_file 写入的内容。Agent 通过 Shell 写的代码不计入，开了 Bash First 以后这部分会更多。
- 测试文件、白名单以外的文件（json、yaml、md、properties 等）不计入。
- 一次生成只在第一个包含该文件的 commit 里测量一次。用 `git add -p` 把 Agent 的改动拆成多次提交，后面几次提交里的 Agent 行会漏掉。
- 生成后 14 天内提交的才计入；单次生成超过 2 万行、或文件超过 8MB 的不做逐行比对。
- 按提交时的 SHA 记录。rebase、cherry-pick、squash 之后 SHA 会变，和码云上看到的对不上。
- 只有装了 DevClaw 的机器上的提交有数据。
- 不补历史数据。

## 10. 改动范围与测试

| 文件                                                   | 改动                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `src/main/services/commit-file-agent-lines.ts`（新增） | 纯函数：解析 `diff-tree --unified=0` 输出、挑行号、压缩区间                  |
| `src/main/services/adoption-tracker.ts`                | 测量任务取 diff；逐文件测量时记录行号，构造 `code_commit_file`               |
| `src/main/services/adoption-index.ts`                  | 文件事件和 `code_adopt` 同一事务写入；关联的生成记录没全部测量成功就回滚重试 |

后端、ES 映射、看板、渲染进程都不改。

测试：

- `src/main/services/commit-file-agent-lines.test.ts`：
  - diff 解析：新增、删除、无结尾换行、长得像文件头的代码行、路径含空格和中文、带转义的路径、二进制文件。
  - git 调用：根提交、普通提交、merge commit 按第一个父提交、git 跑不起来时返回空。
  - 行号挑选：重复的 `}` 落在 Agent 代码旁边、新增行不够时计入 `agentLineCountOutsideDiff`、拿不到 diff 时降级。
  - 区间压缩与截断。
- `src/main/services/adoption-index.test.ts`：生成记录被别处先测量时，文件事件和 `code_adopt` 一起回滚；重测后一起写入。
- `tests/adoption-commit-file.spec.ts`（已加入 `npm run test:adoption`）：在临时 git 仓库里走完整链路，覆盖同一提交里 Agent 修改和人工代码并存、新文件被人工改掉一行、删除文件、根提交，并核对每个 commit 的三项行数之和、`genEventIds` 都和 `code_adopt` 一致。

发布前在测试环境发一条事件，确认 ES 能收下、字段类型符合预期。
