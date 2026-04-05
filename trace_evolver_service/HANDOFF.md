# Trace Evolver Service 交接文档

## 1. 项目背景

这个子项目是从 `cmbCowork` 中拆出来的一个**独立 Python 离线服务**，目标是基于 Cowork 已经采集到的真实 trace，离线生成技能演化候选产物。

它当前位于：

- `/Users/heyirui/.codex/worktrees/9876/cmbCowork/trace_evolver_service`

这套服务**不接入 Cowork runtime**，也**不会自动发布技能**。它的职责是：

1. 读取本地 trace 文件
2. 读取本地 skill bundle 目录
3. 基于 trace 提炼 `HypothesisPatch`
4. 生成 candidate bundle
5. 导出 diff / lineage / evaluation / summary

后续可以继续扩展，但当前版本故意保持保守。

---

## 2. 我们讨论后明确下来的设计目标

### 2.1 总目标

构建一个 `Trace-Only Skill Evolution Service V1`：

- Python 实现
- FastAPI 服务形态
- 本地调试优先
- 只支持本地文件输入
- 不做 K8s / CronJob
- 不做 Cowork runtime 集成
- 不做自动发布

### 2.2 方法目标

这套系统借鉴了 `Trace2Skill` 的流水线思想，但做了适配：

- 只做 `trace-only hypothesis distillation`
- 没有 artifacts
- 没有真实环境
- 没有 replay
- 没有“论文版的验证闭环”

因此，系统产生的是：

- `HypothesisPatch`
- `CandidateBundle`
- `EvaluationReport`

而不是：

- `ValidatedPatch`

### 2.3 文件修改目标

V1 支持优化 skill bundle 中的：

- `SKILL.md`
- 白名单内其他 `*.md`

V1 不处理：

- `scripts/`
- `templates/`
- `assets/`
- 其他非 Markdown 文件

非 Markdown 文件在导出 candidate bundle 时**原样透传**。

### 2.4 运行边界

V1 明确只支持：

- 本地绝对路径输入
- 本地 skills roots

V1 明确不支持：

- S3
- 真实环境验证
- artifacts 对照
- 正式技能发布

---

## 3. 设计上已经确认的核心原则

### 3.1 thread / trace / episode / family 的关系

这个项目没有把“单个 trace”直接当成技能蒸馏单元，也没有把“整个 thread”粗暴当成一个样本，而是采用三层结构：

- `trace`：最小证据单元
- `episode`：最小蒸馏单元
- `family`：最小晋升/归纳单元

解释：

- 同一 thread 中可能有多个子任务，因此不能直接拿整个 thread 去产 skill
- 单个 trace 又太碎，无法表达“失败 -> 修正 -> 成功”的链路
- 所以先在同 thread 内切出 episode，再跨 thread 聚 family

### 3.2 ErrorAnalyst 的设计

我们最终确定：

- **对外仍然是单 analyst**
- **对内拆成两阶段**

也就是：

1. `diagnosis + bounded markdown ReAct`
2. `patch planning + patch writing`

这么做的原因：

- 保留论文里“单 analyst”的心智模型
- 但把工程边界显式化，特别是：
  - 哪些文件可读
  - 哪些文件可写
  - 哪些 patch 该 hold

### 3.3 为什么不是 full ReAct

我们讨论后的结论是：

- 当前没有真实环境，没有 artifacts，没有 ground truth
- 所以**不适合做 full ReAct-style error validation**

当前合适的范围是：

- 只在“找和读相关 Markdown 文件”这一步上使用 **bounded markdown ReAct**
- 不让 ReAct 承担环境验证或真实修复验证

### 3.4 patch 的内部格式

内部 patch 一律用 **JSON patch / EditOp** 表示，不能直接拿 unified diff 做主存储格式。

原因：

- unified diff 适合导出和审阅
- 不适合作为合并和安全写回的核心格式

最终流程应当是：

1. analyst 生成结构化 patch
2. Python patch engine 应用 patch
3. 再从 old/new 文件生成 unified diff

### 3.5 写回必须由 Python 处理

这个点已经达成明确共识：

- LLM 不直接写最终文件
- 所有文件改写由 Python patch engine 负责

原因：

- 需要路径白名单
- 需要对全文可见文件做精确文本编辑
- 需要冲突约束
- 需要 candidate bundle 副本写回
- 需要后续生成 diff

### 3.6 版本号规则

新增了一条明确规则：

- 每次导出 candidate bundle 时，最终 `SKILL.md` 的 frontmatter 必须带 `version`
- 如果原来没有 `version`：
  - 视为 `v1.0.0`
  - 导出时写成 `v1.0.1`
- 如果原来已经有语义版本：
  - 只增加 patch 位
  - 例如 `v1.2.3 -> v1.2.4`

---

## 4. 当前实现概览

### 4.1 已创建的子项目

项目目录：

- `/Users/heyirui/.codex/worktrees/9876/cmbCowork/trace_evolver_service`

### 4.2 主要文件

#### 配置与入口

- `pyproject.toml`
- `README.md`
- `trace_evolver/__main__.py`
- `trace_evolver/main.py`
- `trace_evolver/config.py`

#### 数据模型与存储

- `trace_evolver/schemas.py`
- `trace_evolver/db.py`

#### 主流程

- `trace_evolver/service.py`

#### 输入 / catalog / episode / family

- `trace_evolver/source.py`
- `trace_evolver/catalog.py`
- `trace_evolver/episodes.py`

#### 分析与 patch

- `trace_evolver/analysis.py`
- `trace_evolver/patching.py`
- `trace_evolver/evaluate.py`

#### 测试

- `tests/test_api.py`

---

## 5. 当前主流程是怎样实现的

### Stage 1: 输入与标准化

由以下模块负责：

- `source.py`
- `catalog.py`
- `episodes.py`

流程：

1. `LocalTraceSource.materialize()` 接收本地绝对路径
2. 把 `.jsonl` 复制到当前 run 的 staging 目录
3. `load_imported_traces()` 解析成 `ImportedTrace`
4. 按 `threadId` 组装 thread
5. 按启发式规则切分 `episode`
6. 对 episode 做 family 聚类
7. 扫描 skills roots，构建 `SkillCatalog` 与 `MarkdownCatalog`

### Stage 2: 分析与 patch 生成

由 `analysis.py` 负责。

#### SuccessAnalyst

特点：

- 单次 pass
- 从成功 episode 中提炼可复用模式
- 当前实现会优先向 `SKILL.md` 追加 trace-grounded success pattern

#### ErrorAnalyst

特点：

- 对外是单 analyst
- 对内是两阶段

##### Phase A

- 做 `failure_surface` 提取
- 做 `suspected_root_cause` 提取
- 抽 `evidence_spans`
- 执行 bounded markdown selection

##### Phase B

- 基于已完整可见文件生成 `HypothesisPatch`
- 仅允许修改：
  - `SKILL.md`
  - 已完整加载的白名单 `.md`
  - 或创建新的 `.md`

### Stage 3: merge、candidate 物化、评估、导出

由以下模块负责：

- `service.py`
- `patching.py`
- `evaluate.py`

流程：

1. 按 `(target_skill_id, family_id)` 把 patch 分桶
2. 在桶内做简单 conflict split
3. 做 patch dedupe
4. 交给 `PatchEngine` 在 candidate bundle 副本上应用
5. 自动 bump `SKILL.md` version
6. 生成 unified diff 和 diff.json
7. 跑离线评估
8. 导出：
   - `bundle/`
   - `diff.patch`
   - `diff.json`
   - `lineage.json`
   - `evaluation.json`
   - `summary.md`

---

## 6. 当前已经实现的能力

### 6.1 FastAPI 接口

已实现：

- `POST /runs`
- `GET /runs/{run_id}`
- `GET /runs/{run_id}/status`
- `GET /runs/{run_id}/candidates`
- `GET /runs/{run_id}/candidates/{candidate_id}`
- `GET /runs/{run_id}/candidates/{candidate_id}/diff`
- `GET /runs/{run_id}/candidates/{candidate_id}/bundle/{path}`
- `GET /healthz`
- `GET /version`

### 6.2 本地输入

已实现：

- 单个 `.jsonl` 文件
- trace 根目录
- thread 目录

并且：

- 只接受绝对路径
- 坏行跳过，不中断 run
- 同一 `traceId` 去重

### 6.3 bundle 物化

已实现：

- 复制完整基线 bundle 到 candidate staging
- Markdown patch 应用
- 非 Markdown 文件透传
- `SKILL.md` frontmatter 校验
- Markdown parse 校验
- unified diff 生成

### 6.4 candidate 版本号

已实现：

- candidate 导出时自动处理 `SKILL.md.version`
- 缺省 -> `v1.0.1`
- 现有版本 -> patch + 1

### 6.5 测试

当前测试已覆盖：

1. 本地端到端创建 run，生成 candidate bundle
2. 读取 diff 和 bundle 文件
3. 非 Markdown 文件透传
4. 无 version 时写成 `v1.0.1`
5. 有 `v1.2.3` 时写成 `v1.2.4`
6. 相对路径输入被拒绝

当前测试命令：

```bash
pytest trace_evolver_service/tests -q
```

当前结果：

- `3 passed`

---

## 7. 当前实现和原始理想设计之间的差距

这部分非常重要，后续 Claude 接手时要明确知道哪些是“已经实现”，哪些只是“计划上确认”。

### 7.1 当前没有真实 LLM 调用

虽然设计里预留了 `model_profile`，但当前实现**没有接真实 LLM / embedding 服务**。

现状：

- `SuccessAnalyst` 是启发式逻辑
- `ErrorAnalyst` 是启发式逻辑
- bounded markdown ReAct 也是基于 token overlap 的贪心选择
- family 聚类也是启发式 token/Jaccard 相似度

也就是说：

- **当前系统已经是完整框架**
- 但 analyst / selection / clustering 还是“占位实现”

后续 Claude 可以把这些模块逐步替换成真实模型调用，而不需要推翻主流程。

### 7.2 当前没有真正的 Trace2Skill merge operator

现在的 merge 是保守简化版：

- 分桶
- 简单冲突拆分
- 相同 op 签名去重

还没有实现更强的：

- prevalence-weighted semantic merge
- 更细粒度的 patch 合并策略
- 语义冲突裁决

### 7.3 当前 patch writer 比较保守

现在的 patch 主要策略是：

- 优先往 `SKILL.md` 末尾追加 trace-grounded block
- 如果选中了额外 md，则对其中一个文件追加 note

还没有实现更丰富的：

- heading 级语义落点规划
- 更细的 rewrite 策略
- 对多个 reference 文件的更智能 patch 分配

### 7.4 当前评估是 plausibility，不是验证

这是设计上故意如此，不是缺陷，但需要写清楚。

现状：

- `evaluate.py` 只评估证据、重复度、泛化性、冲突风险、膨胀风险
- 没有真实环境验证
- 没有 artifacts 对照
- 没有 replay

所以当前 recommendation 的含义是：

- 这个 candidate 是否“值得人工进一步看”

而不是：

- 这个 candidate 是否已经被证明有效

### 7.5 当前 run 是同步执行

`POST /runs` 目前会同步执行整个 run，再返回结果。

这对本地调试是合理的，但后续可能需要：

- 后台任务
- 异步队列
- 可取消 run
- 更细粒度进度状态

---

## 8. 目前重要实现文件说明

### `trace_evolver/service.py`

最重要的总控文件。

适合 Claude 先看它来理解全局。

重点方法：

- `create_run()`
- `get_run()`
- `_execute_run()`
- `_merge_patches()`
- `_persist_candidate()`
- `_write_candidate_artifacts()`

### `trace_evolver/analysis.py`

当前最值得继续演进的文件。

如果 Claude 要把启发式实现替换成真实 LLM，这里会是主要切入点：

- `BoundedMarkdownReAct.select()`
- `SuccessAnalyst.analyze()`
- `ErrorAnalyst.analyze()`
- `ErrorAnalyst._diagnose()`
- `ErrorAnalyst._write_patch()`

### `trace_evolver/patching.py`

当前最重要的安全边界文件。

如果 Claude 要增强 patch 语义能力，也不应该绕开这个文件。

重点方法：

- `PatchEngine.apply()`
- `_apply_op()`
- `_apply_exact_edit()`
- `_validate_bundle()`
- `_bump_skill_version()`

---

## 9. 推荐的后续开发优先级

如果下一位协作者是 Claude，我建议按这个顺序推进。

### P1. 接入真实 LLM / embedding

优先替换这些启发式模块：

1. `SuccessAnalyst`
2. `ErrorAnalyst`
3. `BoundedMarkdownReAct`
4. `FamilyBuilder`

但要保留现有接口，不要直接把主流程推翻。

### P2. 增强 merge 逻辑

可以向 Trace2Skill 再靠近一些：

- 更强的 patch grouping
- prevalence-weighted merge
- 更细的冲突拆分
- 更稳的 candidate 生成

### P3. 增强 patch planner / patch writer

目标：

- 不只是 append 到文件尾
- 可以更稳定地落到合适 heading
- 更好地利用 selected markdown files

### P4. 增强评估

在没有真实环境前提下，仍然可以做得更好：

- matched / distractor 构造更合理
- 更细的重复度/冲突度打分
- 对 patch 的 section-level scoring

### P5. 后续再考虑发布链路

当前不建议先做自动发布。

应该先让：

- candidate 质量
- patch merge 质量
- analyst 稳定性

这些基础能力到位。

---

## 10. Claude 协作建议

如果你要让 Claude 接手，建议它先按下面顺序读代码：

1. `trace_evolver_service/HANDOFF.md`
2. `trace_evolver/trace_evolver/service.py`
3. `trace_evolver/trace_evolver/analysis.py`
4. `trace_evolver/trace_evolver/patching.py`
5. `trace_evolver/tests/test_api.py`

建议 Claude 接手时遵守这些约束：

- 不要把当前 `trace-only` 系统包装成“已验证”
- 不要绕过 Python patch engine 直接让模型写最终文件
- 不要破坏本地-only 输入边界
- 不要先做发布链路，优先把 analyst / merge / evaluation 质量做好
- 如果引入真实 LLM，尽量保持 `SuccessAnalyst` / `ErrorAnalyst` / `PatchEngine` 这些边界不变

---

## 11. 当前运行方式

安装：

```bash
python3 -m pip install -e './trace_evolver_service[dev]'
```

启动服务：

```bash
cd /Users/heyirui/.codex/worktrees/9876/cmbCowork/trace_evolver_service
python -m uvicorn trace_evolver.main:app --reload
```

测试：

```bash
pytest trace_evolver_service/tests -q
```

---

## 12. 交接结论

当前状态可以概括为：

- **框架已搭好**
- **主流程已跑通**
- **本地 API 可用**
- **candidate bundle 导出可用**
- **版本号递增规则已落地**
- **测试已覆盖基础端到端路径**

但同时：

- **analyst 还是启发式实现**
- **bounded markdown ReAct 还是启发式**
- **merge 还是简化版**
- **评估不是验证，只是 plausibility scoring**

这意味着现在最适合的协作方向不是“重做项目”，而是：

- 在当前框架上继续把 analyst / merge / scoring 做强
- 保持现有主流程与边界不变
