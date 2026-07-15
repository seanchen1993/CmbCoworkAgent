# Agent 有效生成行数与采纳率计算口径

> 适用对象：需要在 DevClaw 外部自行计算代码采纳率并上报 `code_gen` / `code_adopt` 的系统。
> 本文整理自客户端 commit 时的采纳率计算逻辑，重点说明 `effectiveGeneratedLineCount` 和 `adoptedLineCount` 怎么算。

## 1. 一句话口径

对每一次 Agent 代码生成，先把生成内容拆成「归一化非空行」；在 commit / 上线时，用最终入库内容去匹配这些行。

但是，分母不是简单的「Agent 当初生成了多少行」。如果后续仍由 Agent 把自己早先生成的某些行改掉或删掉，这些旧行会从旧 generation 的分母里扣除，扣完之后的行数才是：

```
effectiveGeneratedLineCount = Agent 有效生成行数
adoptedLineCount = 有效生成行里最终仍出现在 commit / 上线产物里的行数
提交采纳率 = adoptedLineCount / effectiveGeneratedLineCount
```

人手工改掉或删掉 Agent 生成行时，不扣分母，只会让这行不再计入采纳分子。这表示用户没有原样采纳该行。

## 2. 上报字段对应关系


| 字段                                     | 含义                                     | 计算来源                                                      |
| ---------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| `code_gen.lineCount`                     | 本次生成的净新增归一化行数               | 生成时计算，`edit_file` 会剔除 `oldString` 中未变化的上下文行 |
| `code_adopt.generatedLineCount`          | 与配对`code_gen.lineCount` 一致          | 通常直接回填生成时的`lineCount`                               |
| `code_adopt.effectiveGeneratedLineCount` | Agent 有效生成行数，也就是提交采纳率分母 | 从`generatedLineCount` 中扣除后续 Agent 自己替换/删除掉的旧行 |
| `code_adopt.adoptedLineCount`            | 被采纳行数，也就是提交采纳率分子         | 有效生成行中仍出现在 commit / 上线产物里的行                  |

外部系统如果无法识别「后续 Agent 自己替换/删除」这一类操作，可以退化为：

```
effectiveGeneratedLineCount = generatedLineCount
```

这样能保证数据可用，但比 DevClaw 内部口径更保守：Agent 自我修订掉的旧草稿行会继续留在分母里，采纳率可能偏低。

单独对接时，至少按下面结构准备两类事件。接口地址、鉴权令牌等以服务端提供的信息为准；本文只约定采纳率计算相关字段。

`code_gen` 在一次 Agent 代码生成完成后上报：


| 字段                                             | 必填 | 说明                                                                  |
| ------------------------------------------------ | ---- | --------------------------------------------------------------------- |
| `clientEventId`                                  | 是   | 本次生成事件的全局唯一 ID，后续`code_adopt.genClientEventId` 用它关联 |
| `source`                                         | 是   | 上报系统标识                                                          |
| `sapId` / `userName`                             | 是   | 开发者身份                                                            |
| `generatedAt`                                    | 是   | 生成发生时间                                                          |
| `lineCount`                                      | 是   | 本次生成的净新增归一化行数，即`length(generatedLines)`                |
| `usedSkills` / `modelName` / `tool` / `language` | 可选 | 用于技能、模型、工具、语言维度统计                                    |

`code_adopt` 在代码 commit / 上线 / 发布时上报：


| 字段                          | 必填 | 说明                                                                          |
| ----------------------------- | ---- | ----------------------------------------------------------------------------- |
| `clientEventId`               | 是   | 本次采纳事件的全局唯一 ID                                                     |
| `genClientEventId`            | 是   | 指向配对`code_gen.clientEventId`                                              |
| `source`                      | 是   | 与配对`code_gen.source` 一致                                                  |
| `sapId` / `userName`          | 是   | 与配对`code_gen` 的开发者一致                                                 |
| `generatedAt`                 | 是   | 原始生成时间，不是上线时间                                                    |
| `generatedLineCount`          | 是   | 等于配对`code_gen.lineCount`                                                  |
| `effectiveGeneratedLineCount` | 是   | 按本文算法算出的有效生成行数；无法识别 Agent 自我修订时填`generatedLineCount` |
| `adoptedLineCount`            | 是   | 有效生成行中最终被采纳的行数                                                  |
| `pushed`                      | 是   | 上线/发布场景固定为`true`                                                     |
| `pushedAt`                    | 是   | commit / 上线 / 发布时间                                                      |
| `usedSkills` / `modelName`    | 可选 | 建议与配对`code_gen` 保持一致                                                 |

## 3. 行归一化规则

所有行数和匹配都使用同一套归一化逻辑。

```text
normalizeLine(line):
    s = trim(line)                   # 去掉首尾空白
    s = replaceRegex(s, /\s+/, " ")  # 连续空白折叠为一个空格，含 tab
    return s

normalizedNonBlankLines(text):
    result = []
    for rawLine in splitByCRLFOrLF(text):
        normalized = normalizeLine(rawLine)
        if normalized != "":
            append result, normalized
    return result
```

内部实现为了节省空间，会把归一化后的行做 FNV-1a 32-bit hash，然后按多重集匹配。外部实现可以直接用归一化后的字符串做多重集 key，更容易避免 hash 冲突。

注意：这是多重集，不是普通集合。同一行文本出现 3 次，就要保留 3 个计数。

## 4. 生成基线算法

每次 Agent 写入或编辑文件后，先生成一个 baseline。这里会先算出 `supersededLines` 的候选集合并随 generation 一起保存；但它还没有真正扣到任何更早 generation 的分母上。真正扣减发生在 commit / 上线测量阶段：同一文件的 generation 按新到旧处理，较新的 `supersededLines` 会进入 `supersededCounts`，再由更老的 generation 消费。

- `generatedLines`：本次真正算作 Agent 生成的净新增行。
- `supersededLines`：本次 Agent 编辑明确替换/删除掉的旧行候选。它们会在 commit / 上线测量时用于扣减更早 generation 的有效分母。

### 4.1 多重集工具函数

```text
toMultiset(lines):
    counts = empty map
    for line in lines:
        counts[line] += 1
    return counts

multisetSubtract(sourceLines, subtractLines):
    subtractCounts = toMultiset(subtractLines)
    kept = []

    for line in sourceLines:
        if subtractCounts[line] > 0:
            subtractCounts[line] -= 1
        else:
            append kept, line

    return kept
```

### 4.2 buildBaseline

```text
generationOccurrences(event):
    if event.tool != "edit_file":
        return 1
    if event.occurrences is a positive finite number:
        return floor(event.occurrences)
    # edit_file 的空文件插入场景可能返回 0，但 newString 实际出现 1 次
    return 1

deletionOccurrences(event):
    if event.occurrences is a finite number:
        return max(0, floor(event.occurrences))
    return 1

repeat(lines, n):
    result = []
    for i in 1..n:
        append all lines to result
    return result

buildBaseline(event):
    rawNewLines = repeat(
        normalizedNonBlankLines(event.generatedContent),
        generationOccurrences(event)
    )

    if event.tool != "edit_file" or event.oldString is missing:
        return {
            generatedLines: rawNewLines,
            supersededLines: [],
            rawGeneratedLineCount: length(rawNewLines)
        }

    oldLines = repeat(
        normalizedNonBlankLines(event.oldString),
        deletionOccurrences(event)
    )

    # newString 中和 oldString 相同的上下文行不算新生成
    generatedLines = multisetSubtract(rawNewLines, oldLines)

    # oldString 中被 newString 替换/删除掉的旧行，用来扣减更早的 Agent 生成
    supersededLines = multisetSubtract(oldLines, rawNewLines)

    return {
        generatedLines,
        supersededLines,
        rawGeneratedLineCount: length(rawNewLines)
    }
```

`code_gen.lineCount = length(generatedLines)`。

## 5. Commit / 上线时的有效行数算法

处理某个文件时，需要拿到：

- 这个文件最终进入 commit / 上线产物的内容，记为 `committedContent`。如果文件在本次 commit 中被删除，则为 `null`。
- 这个文件在归因窗口内尚未测量的 Agent generation，按创建时间从新到旧排序。

内部 DevClaw 的归因过滤条件：

- generation 与 commit 文件路径一致。
- generation 尚未被测量。
- generation 创建时间在最近 14 天内。
- generation 创建时间不晚于 commit 时间加 2 秒容差。这个上界用于避免补扫旧 commit 时，把 commit 之后的新生成误归因到旧 commit。

### 5.1 消费有效行

```text
consumeEffectiveAdoptionLines(generatedLines, supersededCounts, availableCounts):
    effective = 0
    adopted = 0

    for line in generatedLines:
        # 被后续 Agent 编辑替换/删除掉的旧行，从旧 generation 分母扣掉
        if supersededCounts[line] > 0:
            supersededCounts[line] -= 1
            continue

        effective += 1

        # 文件被删除或内容不可读时，availableCounts 为 null，只算有效分母，不算采纳
        if availableCounts is null:
            continue

        # 在最终内容中按多重集消费，避免重复行被重复匹配
        if availableCounts[line] > 0:
            adopted += 1
            availableCounts[line] -= 1

    return { effectiveGeneratedLineCount: effective, adoptedLineCount: adopted }
```

### 5.2 measureFileAtCommit

```text
measureFileAtCommit(pendingGenerationsNewestFirst, committedContent):
    if committedContent is null:
        availableCounts = null
        fileDeleted = true
    else:
        availableCounts = toMultiset(normalizedNonBlankLines(committedContent))
        fileDeleted = false

    supersededCounts = empty map
    sawFullRewrite = false
    results = []

    for gen in pendingGenerationsNewestFirst:
        baseline = gen.baseline

        # 新的 write_file 表示文件被 Agent 从头重写。
        # 因为 write_file 只能写不存在的路径，能走到这里通常意味着旧文件被 Agent 删除后重建。
        # 对更老的 generation，直接判为 Agent 自己废弃，分母和分子都为 0。
        if sawFullRewrite:
            append results, {
                genId: gen.id,
                verdict: "superseded",
                generatedLineCount: length(baseline.generatedLines),
                effectiveGeneratedLineCount: 0,
                adoptedLineCount: 0
            }
            continue

        # 纯删除或纯 supersede 的 Agent edit 没有净新增行。
        # 它自己不产生 code_adopt 计数，但它的 supersededLines 会扣减更早 generation。
        if length(baseline.generatedLines) == 0:
            add all baseline.supersededLines into supersededCounts
            mark gen as measured
            continue

        consumed = consumeEffectiveAdoptionLines(
            baseline.generatedLines,
            supersededCounts,
            availableCounts
        )

        if fileDeleted:
            verdict = "deleted"
            adopted = 0
        else:
            verdict = "committed"
            adopted = consumed.adoptedLineCount

        append results, {
            genId: gen.id,
            verdict,
            generatedLineCount: length(baseline.generatedLines),
            effectiveGeneratedLineCount: consumed.effectiveGeneratedLineCount,
            adoptedLineCount: adopted
        }

        # 当前 generation 替换/删除掉的旧行，会影响更老 generation 的分母
        add all baseline.supersededLines into supersededCounts

        if gen.tool == "write_file":
            sawFullRewrite = true

    return results
```

## 6. 采纳率聚合口径

面板的核心聚合口径如下：

```text
generatedLines = sum(code_gen.lineCount)

measuredGeneratedLines = sum(code_adopt.generatedLineCount)
effectiveGeneratedLines = sum(code_adopt.effectiveGeneratedLineCount)
adoptedLines = sum(code_adopt.adoptedLineCount)

unmeasuredGeneratedLines = max(0, generatedLines - measuredGeneratedLines)
inclusiveEffectiveGeneratedLines = effectiveGeneratedLines + unmeasuredGeneratedLines

提交采纳率 measuredAdoptionRate =
    effectiveGeneratedLines > 0 ? adoptedLines / effectiveGeneratedLines : null

总量提交采纳率 inclusiveAdoptionRate =
    inclusiveEffectiveGeneratedLines > 0 ? adoptedLines / inclusiveEffectiveGeneratedLines : null

入库采纳率 pushedAdoptionRate =
    pushedEffectiveGeneratedLines > 0 ? pushedAdoptedLines / pushedEffectiveGeneratedLines : null
```

因此，外部上报 `code_adopt.effectiveGeneratedLineCount` 会直接影响采纳率分母。

## 7. 典型例子

### 7.1 edit 中的上下文行不算生成

Agent 用 `edit_file` 把下面片段：

```text
class User {
  private String name;
  private String phone;
}
```

改成：

```text
class User {
  private String name;
  private String email;
  private String phone;
}
```

`newString` 有 5 行，但和 `oldString` 相同的 4 行只是上下文，不算生成。

```text
generatedLineCount = 1   # private String email;
supersededLines = 0
```

### 7.2 Agent 自己替换旧行，旧 generation 扣分母

第一次 Agent 生成：

```text
line A
line B
line C
```

第二次 Agent 把 `line B` 改成 `line D`，最终 commit：

```text
line A
line D
line C
```

按新到旧处理：


| generation       | generatedLineCount | effectiveGeneratedLineCount | adoptedLineCount | 说明                                           |
| ---------------- | -----------------: | --------------------------: | ---------------: | ---------------------------------------------- |
| 第二次，`B -> D` |                  1 |                           1 |                1 | `line D` 被采纳                                |
| 第一次，`A/B/C`  |                  3 |                           2 |                2 | `line B` 是被 Agent 后续替换掉的旧草稿，扣分母 |

### 7.3 人手工修改不扣分母

Agent 生成：

```text
line A
line B
```

用户手工改成：

```text
line A
line B changed by human
```

结果：

```text
generatedLineCount = 2
effectiveGeneratedLineCount = 2
adoptedLineCount = 1
```

`line B` 仍是有效生成行，只是没有被原样采纳。

### 7.4 Agent 删除自己早先生成的行

第一次 Agent 生成：

```text
line A
line B
```

第二次 Agent 删除 `line A`，最终 commit：

```text
line B
```

删除操作本身没有净新增行，但它的 `supersededLines = ["line A"]` 会扣减第一次 generation：

```text
第一次 generatedLineCount = 2
第一次 effectiveGeneratedLineCount = 1
第一次 adoptedLineCount = 1
```

## 8. 外部系统落地建议

如果你们要最大程度对齐 DevClaw 内部口径，建议保存如下中间状态：

```text
GenerationRecord:
    genClientEventId
    logicalFileId or filePath
    tool                    # write_file / edit_file / 你方等价操作类型
    generatedAt
    generatedLines          # buildBaseline 结果
    supersededLines         # buildBaseline 结果
    lineCount               # length(generatedLines)
    measured = false
    attribution fields      # sapId, userName, source, usedSkills, modelName 等
```

生成完成时：

```text
baseline = buildBaseline(agentWriteOrEditEvent)
save GenerationRecord

report code_gen:
    clientEventId = genClientEventId
    lineCount = length(baseline.generatedLines)
    generatedAt = generation time
```

上线 / 发布 / commit 时：

```text
for each touched logical file:
    committedContent = final released content for that file, or null if deleted
    pending = unmeasured GenerationRecord for this file, newest first
    results = measureFileAtCommit(pending, committedContent)

    for result in results where result has generatedLineCount > 0:
        report code_adopt:
            genClientEventId = result.genId
            generatedLineCount = result.generatedLineCount
            effectiveGeneratedLineCount = result.effectiveGeneratedLineCount
            adoptedLineCount = result.adoptedLineCount
            generatedAt = original generation time
            pushed = true
            pushedAt = release time
```

## 9. 边界条件


| 场景                         | 内部处理                                                 | 外部建议                                                 |
| ---------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| 空行、纯空白行               | 不计数、不匹配                                           | 按本文归一化跳过                                         |
| 缩进变化、多个空格变一个空格 | 归一化后相同则视为同一行                                 | 使用同一归一化                                           |
| 重复相同行                   | 按多重集计数，出现几次算几次                             | 不要用普通 set                                           |
| Agent append                 | 新增行算新 generation；旧 generation 不扣分母            | `oldString` 中仍保留的行不会进入 `supersededLines`       |
| Agent replacement / deletion | 新 generation 的`supersededLines` 扣减旧 generation 分母 | 需要保存 edit 的 old/new 片段                            |
| 用户手工修改                 | 不扣分母，只影响采纳分子                                 | 如果无法识别修改来源，按用户修改处理更保守               |
| 文件被删除后 commit          | 有效分母照算，采纳分子为 0                               | `committedContent = null`                                |
| Agent 删除整个文件再重写     | 较旧 generation 判`superseded`，有效分母为 0             | 如果能识别 Agent 重写，可同口径处理                      |
| 文件移动                     | 内部会把待测 generation 的路径转移到新路径               | 外部用稳定 logicalFileId 更稳                            |
| 超大文件                     | 内部本地 hash 测量有 20000 行保护                        | 外部若能计算可继续上报；不能计算时需和接收端约定降级口径 |
