# Skill Eval 当前评分规则总览

> 代码位置
> - 过程分 + 结束分：`src/main/agent/skill-eval/evaluator.ts`
> - 结果分：`src/main/agent/skill-eval/result-evaluator.ts`

## 0. 顶层公式与判定

| 项 | 公式 / 阈值 | 代码 |
|---|---|---|
| 主综合分 `score` | `processScore × 0.4 + outcomeScore × 0.6` | `evaluator.ts` `combineScores` |
| 通过阈值 `pass` | `score ≥ 0.7` | `PASS_THRESHOLD = 0.7` |
| 结果分独立判定 `result.pass` | `resultScore ≥ 0.7` | `result-evaluator.ts` `PASS_THRESHOLD = 0.7` |
| 单组得分 | `Σ(ok × weight) / Σ(weight)`，保留 4 位 | `scoreChecks` |

⚠️ **结果分目前没并入主公式**，只是单独算一份挂在记录上展示。Plan 这次主分 62% < 70% 判负，靠的是 process 0.4 + outcome 0.6 加权的结果。

---

## 1. 过程分 Process Score（`buildChecks`）

总权重 7。任一项失败按权重扣分。

| # | name | 中文标签 | 权重 | 判定 | 阈值常量 |
|---|---|---|---|---|---|
| 1 | `step_budget_reasonable` | 步骤数合理 | 2 | `trace.steps.length ≤ STEP_BUDGET` | `STEP_BUDGET = 12` |
| 2 | `tool_budget_reasonable` | 工具调用预算合理 | 2 | `totalToolCalls ≤ TOOL_BUDGET` | `DEFAULT_SKILL_EVAL_TOOL_BUDGET = 40` |
| 3 | `no_repeated_tool_calls` | 无重复无效调用 | 2 | 没有"同一工具+同一参数连续调用超过 N 次"的情况 | `MAX_CONSECUTIVE_SAME_CALL = 3`（即第 4 次起算重复） |
| 4 | `input_tokens_reasonable` | 平均 Prompt 输入不过高 | 1 | 平均每次 modelCall 的 prompt 输入（含 cacheRead + cacheCreation）≤ 上限 | `AVG_PROMPT_INPUT_TOKEN_BUDGET = 48_000` |

**重复调用判定**：按 step 内逐个看 `${name}:${JSON.stringify(args)}` 是否与前一次相同，连续相同的 runLength 超过 3 才计为 1 次重复。跨 step 不累计。

---

## 2. 结束分 Outcome Score（`buildOutcomeChecks`）

总权重 9。

| # | name | 中文标签 | 权重 | 判定 |
|---|---|---|---|---|
| 1 | `run_completed_successfully` | 运行成功结束 | 3 | `trace.outcome === "success"` |
| 2 | `final_response_present` | 有最终响应 | 2 | 最后一个 step 的 `assistantText.trim().length > 0` |
| 3 | `terminal_message_success` | 终止消息成功 | 2 | 存在 terminal message 节点（Run Completed / Run Error / Run Cancelled），且 `status === "success"`，且 `outputLength > 0` |
| 4 | `no_tool_result_errors` | 工具结果无错误 | 2 | 没有 `type === "tool_result" && (status === "error" \|\| type === "error" \|\| metadata.error)` 的节点 |

⚠️ 注意点：

- **"有最终响应" 只看最后一个 step**。如果末步是 tool_use 而不是 assistant text，会直接失败，跟整个 trace 里前面写了多少字没关系。
- **"运行成功结束" 权重最大（3）**，但它跟 trace 自身的 outcome 标记挂钩，不验证是否真的产出了东西——这就是为什么"全是 success 却被判负"的常见来源。

---

## 3. 结果分 Result Score（`result-evaluator.ts` `buildChecks`）

总权重 11。

| # | name | 中文标签 | 权重 | 判定 |
|---|---|---|---|---|
| 1 | `final_response_substantive` | 最终响应有效 | 2 | 有产物时（changedFiles 或 artifactSignals 非空）自动通过；否则要求 `finalResponseLength ≥ 20` |
| 2 | `has_output_signal` | 存在产出信号 | 3 | `changedFiles.length > 0` 或 `artifactSignals.length > 0` 或 `finalResponseLength ≥ 20` |
| 3 | `has_validation_signal` | 存在验证动作 | 2 | `validationCommands.length > 0` |
| 4 | `no_tool_result_errors` | 工具结果无错误 | 2 | `toolResultErrors === 0`（同结束分定义） |
| 5 | `no_dangerous_commands` | 无高风险命令 | 2 | `dangerousCommands.length === 0` |

常量：

- `MIN_FINAL_RESPONSE_CHARS = 20`：最终响应长度门槛。
- finalResponseLength 在 result 评估里会**回退取 terminal message 的 output**，比 evaluator.ts 的更宽松。

---

## 4. 工具 / 命令的识别名单（影响结果分关键指标）

### 4.1 "改动文件" `CHANGED_FILE_TOOL_NAMES`

工具调用命中以下任一名字时，取其参数路径（`path / file_path / filePath / targetPath / outputPath / filename`）作为一条 changedFiles：

```
write_file
edit_file
apply_patch
prepare_save_code_exec_tool
save_code_exec_tool
```

### 4.2 "产物信号" `ARTIFACT_TOOL_NAMES`

比 changedFile 多一项 `browser_playwright`：

```
write_file
edit_file
apply_patch
browser_playwright
prepare_save_code_exec_tool
save_code_exec_tool
```

### 4.3 "Shell 工具"（验证 / 风险命令的入口）`SHELL_TOOL_NAMES`

```
execute  exec  shell  bash  exec_command  code_exec  invoke_deferred_tool
```

工具参数会按 `command / cmd / script / shellCommand / argv` 顺序取第一个非空作为命令文本，再去做正则匹配。

### 4.4 "验证命令" `VALIDATION_COMMAND_PATTERNS`

正则（不区分大小写）：

```
\bnpm   (?:run )?(?:test|build|lint|typecheck)\b
\bpnpm  (?:run )?(?:test|build|lint|typecheck)\b
\byarn  (?:run )?(?:test|build|lint|typecheck)\b
\b(?:pytest|vitest|jest)\b
\bcargo test\b
\bgo test\b
\bmvn test\b
\bgradle test\b
\btsc --noEmit\b
\bplaywright (?:test|screenshot|show-report)\b
\bnpm run [^&|;]*screenshot\b
\bpnpm (?:run )?[^&|;]*screenshot\b
\byarn (?:run )?[^&|;]*screenshot\b
```

### 4.5 "高风险命令" `DANGEROUS_COMMAND_PATTERNS`

```
\brm -[^\s]*r[^\s]*f\b        # rm -rf 各种写法
\bgit reset --hard\b
\bgit checkout --\b
\bsudo\b
\bchmod 777\b
\bmkfs\b
:\(\)\s*\{                    # fork bomb
\bdd if=
```

### 4.6 "子 agent" `SUBAGENT_TOOL_NAMES`

```
task
```

子 agent 的 `subagentCompleted / subagentFailed / subagentResultLength` 通过遍历 `tool_result` 节点的 `parentId` 反查父 `task` tool 节点统计。`subagentFailed > 0` 会进 `issues`、`warnings`，但**目前不直接影响结果分**。

---

## 5. Warnings / Issues 文案触发条件

### 5.1 过程 / 结束维度 warnings（`buildWarnings`、`buildOutcomeWarnings`）

| 文案 | 触发 |
|---|---|
| `任务结果为 <outcome>` | `trace.outcome !== "success"` |
| `检测到 N 个错误节点` | `errorCount > 0` |
| `工具调用 N 次，超过默认预算 40` | `toolCalls > 40` |
| `成果质量低于通过阈值` | `outcomeScore < 0.7` |
| `<trace.errorMessage>` 原文 | `trace.errorMessage` 非空 |

### 5.2 结果维度 warnings / issues（`buildWarnings`、`buildIssues`）

| 文案 | 触发 |
|---|---|
| `没有检测到验证动作` | `validationCommands.length === 0` |
| `没有检测到明确文件或产物信号` | `changedFiles.length === 0 && artifactSignals.length === 0` |
| `检测到 N 个子 agent 失败` | `subagentFailed > 0` |
| `检测到 N 条高风险命令` | `dangerousCommands.length > 0` |
| issue: `<trace.errorMessage>` | `trace.errorMessage` 非空 |
| issue: `子 agent 失败 N 次` | `subagentFailed > 0` |
| issue: `检测到高风险命令` | `dangerousCommands.length > 0` |

---

## 6. Token 与统计指标（不参与打分，只展示）

`summarizeTokenUsage` 在每次 modelCall 上累加 / 取最大值：

| 指标 | 算法 |
|---|---|
| `modelCallCount` | modelCalls 数量 |
| `totalInputTokens` | Σ `usage.inputTokens` |
| `totalOutputTokens` | Σ `usage.outputTokens` |
| `promptInputTokens` | Σ `(input + cacheRead + cacheCreation)` |
| `totalTokens` | Σ `usage.totalTokens`，缺则 fallback 到 `input+output` |
| `cacheReadTokens` | Σ `usage.cacheReadTokens` |
| `cacheCreationTokens` | Σ `usage.cacheCreationTokens` |
| `peakInputTokens` | `max(input + cacheRead + cacheCreation)` 单次最大 |
| `maxContextTokens` | `max(input)` 单次最大（已 deprecated，建议用 peakInputTokens） |
| `averagePromptInputTokens` | `promptInputTokens / modelCallCount` |
| `totalTokensIncludesCache` | `true / false / "mixed"`，反映 provider 是否在 totalTokens 里含 cache |

---

## 7. Skill 名字解析

`parseSkill(raw)`：用正则 `/^(.*?)-(v\d+(?:\.\d+){0,3})$/` 拆 `skillName` 和 `skillVersion`，例如：

- `autodev-plan-v1.0.0` → `{ skillName: "autodev-plan", skillVersion: "v1.0.0" }`
- `random-skill`（不含 v 后缀）→ `{ skillName: "random-skill" }`

---

## 8. 一眼盘点：当前规则的几个已知坑

1. **plan / design 类纯文本 skill 永远拿不到满分**——没有 write_file 也没有 npm test，结果分必然挂 5 分（产物 3 + 验证 2）。
2. **"有最终响应" 只看末步 assistantText**，agent 末步是 tool_use 时会被误判（结束分 evaluator.ts 这个分支没回退到 terminal message，结果分那边才有回退）。
3. **结果分目前不进主公式**——产出 0 也能靠 process+outcome 抬到 70%。如果想让"没产物即失败"，需要把 result 分并入或者设硬门槛。
4. **重复调用判定不跨 step**——agent 在两个 step 各调一次相同工具不会算重复。
5. **STEP_BUDGET=12 偏紧**，对 plan / codegen 这类深度链路容易溢出，过程分先扣 2。
6. **验证命令正则只覆盖前端/通用栈**——Python（pip）、Java、Rust 测试某些命令变体匹配不到（不过 pytest/jest/cargo test/go test 已覆盖主路径）。

---

## 9. 一个调参建议清单（如果要让评估更准）

- 给 evaluator 加 **per-skill rubric 配置**（plan 类放宽产物要求，codegen 类提高验证要求）。
- 把 `outcomeChecks` 里 "有最终响应" 也加 terminal message 回退，跟 result 分一致。
- 把 result 分以一定权重并入主公式（例如 process 0.2 + outcome 0.4 + result 0.4）。
- 重复调用判定改成全局而不是 step 内。
- 把所有阈值集中到 `eval/configs/thresholds.yaml`（你 `autoBizDevOps-eval-design.md` 第 5 节已经规划过），代码里用常量引用，方便回归调参。
