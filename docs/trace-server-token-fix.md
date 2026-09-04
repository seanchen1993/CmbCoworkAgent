# Trace 上报：token 与 modelCallCount 口径修正（服务端）

## 背景

客户端上报的 trace 里，`modelCalls` 数组有条数上限（前 64 条完整、之后是只含时间和 token 的骨架，最多 512 条）。服务端目前**遍历这个数组求和**得到 token 用量，所以超长会话的 token 和模型调用次数会被少计——一个真实做了 1000 次模型调用的会话，只能统计到 512 次。

客户端已经改为在采集时按次累加，并把准确总量放在 trace 顶层。服务端只需改为**优先读取这几个字段**即可。

**本次改动不需要修改 ES mapping。**

---

## 需要改的两处

### 1. `AgentTraceDTO` 补 4 个字段

```java
@Data
@JsonIgnoreProperties(ignoreUnknown = true)
public class AgentTraceDTO {

    // ... 保留现有全部字段 ...

    /** 客户端按次累加的输入 token 总量，不受 modelCalls 数组上限影响 */
    private Long totalInputTokens;

    /** 客户端按次累加的输出 token 总量 */
    private Long totalOutputTokens;

    /** 客户端按次累加的 token 总量 */
    private Long totalTokens;

    /** 客户端统计的模型调用次数，可能大于 modelCalls.size() */
    private Long totalModelCalls;
}
```

老版本客户端上报的 JSON 里没有这几个字段，反序列化后为 `null`，下面的代码会自动回落到原有逻辑。

### 2. 求和逻辑改为「优先取字段，缺失才遍历」

**改前：**

```java
long inputTokens = 0;
long outputTokens = 0;
long totalTokens = 0;
long cacheReadTokens = 0;
if (dto.getModelCalls() != null) {
    for (AgentTraceDTO.TraceModelCallDTO mc : dto.getModelCalls()) {
        if (mc.getTokenUsage() != null) {
            inputTokens += Optional.ofNullable(mc.getTokenUsage().getInputTokens()).orElse(0L);
            outputTokens += Optional.ofNullable(mc.getTokenUsage().getOutputTokens()).orElse(0L);
            totalTokens += Optional.ofNullable(mc.getTokenUsage().getTotalTokens()).orElse(0L);
            cacheReadTokens += Optional.ofNullable(mc.getTokenUsage().getCacheReadTokens()).orElse(0L);
        }
    }
}
```

**改后：**

```java
long inputTokens = 0;
long outputTokens = 0;
long totalTokens = 0;
long cacheReadTokens = 0;

// cacheReadTokens 始终从数组求和：客户端没有对应的顶层字段，口径保持不变
if (dto.getModelCalls() != null) {
    for (AgentTraceDTO.TraceModelCallDTO mc : dto.getModelCalls()) {
        if (mc.getTokenUsage() != null) {
            cacheReadTokens += Optional.ofNullable(mc.getTokenUsage().getCacheReadTokens()).orElse(0L);
        }
    }
}

boolean hasClientTotals = dto.getTotalTokens() != null || dto.getTotalInputTokens() != null;
if (hasClientTotals) {
    // 新版客户端：按次累加的准确值
    inputTokens  = Optional.ofNullable(dto.getTotalInputTokens()).orElse(0L);
    outputTokens = Optional.ofNullable(dto.getTotalOutputTokens()).orElse(0L);
    totalTokens  = Optional.ofNullable(dto.getTotalTokens()).orElse(0L);
} else {
    // 老版本客户端：维持原有的数组求和
    if (dto.getModelCalls() != null) {
        for (AgentTraceDTO.TraceModelCallDTO mc : dto.getModelCalls()) {
            if (mc.getTokenUsage() != null) {
                inputTokens  += Optional.ofNullable(mc.getTokenUsage().getInputTokens()).orElse(0L);
                outputTokens += Optional.ofNullable(mc.getTokenUsage().getOutputTokens()).orElse(0L);
                totalTokens  += Optional.ofNullable(mc.getTokenUsage().getTotalTokens()).orElse(0L);
            }
        }
    }
}
```

### 3. `modelCallCount` 同样优先取字段

找到给 `TraceEsDocument.modelCallCount` 赋值的地方（目前应为 `dto.getModelCalls().size()`），改为：

```java
Integer modelCallCount = dto.getTotalModelCalls() != null
        ? dto.getTotalModelCalls().intValue()
        : (dto.getModelCalls() == null ? 0 : dto.getModelCalls().size());
```

---

## 不需要改的地方

| 项 | 说明 |
|---|---|
| **ES mapping** | `totalInputTokens` / `totalOutputTokens` / `totalTokens` / `modelCallCount` 都已存在，类型不变 |
| **`TraceEsDocument`** | 不新增字段。注意索引是 `"dynamic": "strict"`，**新增字段必须先改 mapping，否则整篇文档会被拒** |
| **`totalToolCalls`** | 已经是直接取 DTO，客户端那边已修好，服务端无需改动 |
| **`cacheReadTokens`** | 维持数组求和，与客户端口径一致 |
| **`_raw`** | 不变。它是 `enabled: false`，只存不索引 |

---

## 验证方式

1. 用**新版客户端**跑一个工具调用超过 512 次的长任务，上报后检查 ES 文档：
   - `totalInputTokens` 应等于该会话真实消耗，而不是 `modelCalls` 数组求和的结果
   - `modelCallCount` 应大于 `_raw.modelCalls` 数组长度（数组封顶 512）
2. 用**老版本客户端**（或手工构造一份不含这 4 个字段的 JSON）上报，确认结果与改动前完全一致。
3. 确认没有出现 `strict_dynamic_mapping_exception`。

---

## 影响范围

| 指标 | 改前（1000 次模型调用的会话） | 改后 |
|---|---|---|
| `totalInputTokens` | 约 51%（只统计到 512 次） | 100% |
| `totalOutputTokens` | 同上 | 100% |
| `totalTokens` | 同上 | 100% |
| `modelCallCount` | 512 | 1000 |
| `totalToolCalls` | 已准确（客户端已修） | 不变 |

会话越长少计越严重，所以这个偏差是系统性地压低重度使用者的统计值。
