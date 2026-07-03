# 长期记忆系统优化调研

> 日期：2026-06-15 · 状态：调研稿
>
> **范围**：本仓 `src/main/memory/` 长期记忆系统（per-fact 文件 + MEMORY.md 索引 + 检索 + Dream 整合）的优化方向。
> **不涉及**：单次长任务的上下文卸载/Mermaid 任务画布——该话题已有专门调研，见
> [memory-tdai-research.md](./memory-tdai-research.md)、[memory-tdai-feasibility.md](./memory-tdai-feasibility.md)。
>
> **参考工程**（均位于 `C:\ai`）：
> - `claude-code` —— `src/memdir/`（本仓当前实现的蓝本）
> - `openclaw` —— `extensions/memory-core/`（混合检索 + 向量 + dreaming）
> - `TencentDB-Agent-Memory` —— `src/core/{persona,scene,store}`（L0–L3 分层金字塔）
> - `hermes-agent` —— `agent/memory_provider.py` + `plugins/memory/*`（provider 抽象 + 8 个后端）
> - `codex` —— `codex-rs/ext/memories/`（纯文件 + 精细 grep 检索，极简路线）
> - `MiMo-Code`（opencode 分支） —— `packages/opencode/src/memory/`（Scope 模型 + auto-dream/distill）

---

## 0. 结论先行

本仓当前的长期记忆实现质量已经不低（per-fact 文件 + frontmatter + 自动 manifest + FTS3/BM25+LIKE 混合词法检索 + recall 统计 + Dream 整合），是 claude-code memdir 的一个相当完整的移植版本。

调研六个参考工程后，识别出 **三个独立、互不依赖的优化方向**，按"investment vs. payoff"排序：

| 优先级 | 方向 | 一句话 | 工作量 | 依据 |
|---|---|---|---|---|
| **P0-a** | **工作区记忆隔离** | 记忆目录从全局单池改为 `global/` + `projects/<id>/` 双层，按 git 根目录隔离 | 中（路径+注入+分流，存储格式不变） | 本仓代码里已有 TODO；claude-code/MiMo-Code 都有现成算法 |
| **P0-b** | **混合检索升级** | 现有 BM25(FTS3)+LIKE 词法检索之上叠加向量语义检索，RRF 融合 | 中（SQLite 加向量列即可，不换存储） | openclaw/TencentDB 验证有效；中文同义召回是当前最大短板 |
| P1 | 主动/异步召回 | 查询前台等待变成后台 prefetch，或查询时小模型自动选记忆注入 | 小 | hermes prefetch / claude-code findRelevantMemories |
| P2 | 高层抽象 persona | Dream 阶段额外维护一份 `persona.md` 高层画像 | 中 | TencentDB 验证 PersonaMem 48%→76% |
| P2 | recall 反馈升级为 trust score | recall_count → helpful/unhelpful 反馈，影响 Dream 决策 | 小 | hermes holographic `fact_feedback` |
| P3（架构级） | Provider 抽象层 | 记忆后端可插拔（未来接 mem0 等外部服务） | 大，需重构 | hermes |

**建议顺序**：P0-a → P0-b → P1，三者风险递增、收益递减，且 P0-a 是地基性问题（影响范围最广、当前最容易出"跨项目记忆污染"的 bug）。

**二轮外部调研后的修正**（2026-06）：方向不变，但 P0-b 的实现应更保守——先做"词法检索质量 + RRF 融合框架 + JS 内存 cosine/BLOB 向量表"，不要一上来引入外部向量服务或重型向量库。Mem0、Zep/Graphiti、LangGraph/LangMem、Letta、LlamaIndex 的共同趋势是：**分层记忆 + 多信号检索 + 明确作用域 + 可溯源/可失效的事实生命周期**，而不是单纯把所有内容塞进 vector DB。

---

## 1. 当前系统现状

### 1.1 存储与索引

代码：[src/main/memory/store.ts](../src/main/memory/store.ts)、[manifest.ts](../src/main/memory/manifest.ts)

- 记忆目录：`~/.cmbcoworkagent/memory/`（**全局唯一**，见 §1.4 问题）
- per-fact markdown 文件，YAML frontmatter：`name` / `description` / `type ∈ {user, feedback, project, reference}`
- `MEMORY.md`：自动生成的索引（200 行 / 25KB 截断），由 LLM summarizer 维护，bootstrap 时由 `regenerateManifest()` 从 frontmatter 重建
- 索引层：sql.js（SQLite in WASM），表 `chunks`（markdown 按 600 字符切块，120 字符 overlap）+ `chunks_fts`（FTS3）+ `file_hashes`（增量同步用）

### 1.2 检索

[store.ts:279](../src/main/memory/store.ts#L279) `search()`：

- 英文 token：FTS3 `MATCH` + 自实现 BM25（解析 `matchinfo('pcnalx')` 缓冲区）
- 中文 token：bigram 切分（过滤停用词）+ `LIKE` 打分（命中 token 数）
- 两路结果按 `path:startLine` 去重合并，按 score 排序取 top-N
- 副作用：命中的 chunk 会更新 `recall_count` / `last_recalled_at`（供 Dream 使用）

**纯词法，无语义。** 中文还退化成 bigram+LIKE，没有真正的相关性排序模型。

### 1.3 召回时机（被动）

[runtime.ts:2672](../src/main/agent/runtime.ts#L2672)：

- `MEMORY.md` 全文注入 system prompt（[system-prompt.ts:148](../src/main/agent/system-prompt.ts#L148)）
- 提供 `memory_search` / `memory_get` 两个工具（[tools.ts](../src/main/memory/tools.ts)），agent 自己判断要不要调用

即：高层索引始终在上下文里，但**细节记忆完全依赖 agent 主动想起来去搜**。没有"根据本轮 query 自动注入相关记忆"的机制。

### 1.4 提取与整合

- **summarizer**（[summarizer.ts](../src/main/memory/summarizer.ts)）：会话结束后单次 LLM 调用，输出 `operations[]`（create/update/skip）+ 重写后的 `MEMORY.md`，串行队列防止并发写冲突
- **Dream**（[consolidate.ts](../src/main/memory/consolidate.ts)）：7 天 + ≥5 次会话 + (≥20 新增 facts 或 总数≥50) 触发，LLM 决定 archive/merge/create_meta，安全规则：只有 `recall_count=0` 且 `age≥180天` 且非 `user` 类型才能被 archive

这两块设计已经相当成熟，**不在本次优化范围内**（除非要适配 §2.6 的分层）。

### 1.5 ⚠️ 关键缺陷：无工作区隔离

[ipc/memory.ts:36](../src/main/ipc/memory.ts#L36) 和 [ipc/terminal.ts:19](../src/main/ipc/terminal.ts#L19) 都把 `MEMORY_DIR` 写死为 `~/.cmbcoworkagent/memory/`——**所有项目共用一个池子**。

[terminal.ts:14-18](../src/main/ipc/terminal.ts#L14-L18) 已经有人留了 TODO：

```
TODO: 当 CmbCowork 记忆系统改为按项目隔离后，使用与 Claude Code 相同的算法按项目拼接路径：
1. findCanonicalGitRoot(effectiveWorkDir) 获取 git 仓库根目录（worktree 解析到主仓库）
2. sanitizePath() 将路径中非字母数字字符替换为 -
3. 最终路径：~/.cmbcoworkagent/memory/{sanitizedPath}/
参考 claude-code/src/memdir/paths.ts 的 getAutoMemPath() 实现。
```

**后果**：A 项目"用 pnpm、auth 中间件正在重写"这类项目专属事实，会被注入到所有其他项目的对话里——既是噪音也是潜在误导（B 项目的 agent 可能误以为也该用 pnpm）。这是一个**正确性问题**，不只是效率问题。

---

## 2. 六个参考工程逐一分析

### 2.1 claude-code（`src/memdir/`）—— 当前实现的直接蓝本

文件：[memdir.ts](file:///c/ai/claude-code/src/memdir/memdir.ts)、[findRelevantMemories.ts](file:///c/ai/claude-code/src/memdir/findRelevantMemories.ts)

**作用域分层**（`loadMemoryPrompt()`，[memdir.ts:419](file:///c/ai/claude-code/src/memdir/memdir.ts#L419)）：
- **per-project auto memory**：`~/.claude/projects/<slug>/memory/`，`<slug>` 由项目目录路径推导
- **team memory**：`getAutoMemPath()/team`，多人共享，与 project 层 `buildCombinedMemoryPrompt()` 合并注入
- 还有一种 KAIROS "assistant 模式"：append-only 按日期写日志（`logs/YYYY/MM/YYYY-MM-DD.md`），夜间 `/dream` 蒸馏成 MEMORY.md——这是给"永不结束的会话"用的，本仓暂不需要

**主动召回**（`findRelevantMemories.ts`）：
- 每轮提问时，扫描所有 memory 文件头（filename/name/description），喂给一个小模型（Sonnet side-query），让它从 manifest 里**选出 ≤5 个与本轮 query 相关的文件**，返回路径列表
- 排除"最近用过的工具"对应的参考文档（`recentTools` 参数）——避免"工具刚用过，文档再注入就是噪音"
- 这是**同步阻塞**的（在生成回复前等这次小模型调用），用 `alreadySurfaced` 集合避免重复选取

**MEMORY.md 截断规则**：200 行 / 25KB（[memdir.ts:35-38](file:///c/ai/claude-code/src/memdir/memdir.ts#L35-L38)），本仓 [manifest.ts:153-154](../src/main/memory/manifest.ts#L153-L154) 已经照抄了同样的常量。

**本仓与之的差距**：缺 project/global 两层作用域；缺主动召回（只有被动工具）。

---

### 2.2 openclaw（`extensions/memory-core/`）—— 工程化混合检索

文件：[hybrid.ts](file:///c/ai/openclaw/extensions/memory-core/src/memory/hybrid.ts)、[embeddings.ts](file:///c/ai/openclaw/extensions/memory-core/src/memory/embeddings.ts)

**混合检索管线**：
1. 向量检索（embedding cosine similarity）→ `HybridVectorResult[]`
2. FTS5 BM25 → `HybridKeywordResult[]`（`bm25RankToScore`：FTS5 的 `rank` 越小越好，转换成 `1/(1+rank)` 归一化到 (0,1]）
3. `mergeHybridResults()`：按 `id` 合并两路结果，`score = vectorWeight * vectorScore + textWeight * textScore`
4. **时间衰减**（`applyTemporalDecayToHybridResults`）：越新的记忆分数加权越高
5. **MMR 重排**（`applyMMRToHybridResults`，Maximal Marginal Relevance）：避免 top-N 全是高度相似的重复内容，兼顾多样性

**Embedding provider 抽象**：[embeddings.ts](file:///c/ai/openclaw/extensions/memory-core/src/memory/embeddings.ts) 支持 OpenAI / Gemini / Voyage / Mistral / Ollama / 本地模型，统一接口 `MemoryEmbeddingProvider`，有自动降级逻辑（`canAutoSelectLocal`）。

**对本仓的启示**：
- RRF/加权融合公式可以直接照搬，不需要重新设计
- 向量检索不一定要外部 API——Ollama/本地 embedding 模型可以做到零外部依赖
- 时间衰减和 MMR 是"便宜但有效"的小改动，可以和向量检索一起加

---

### 2.3 TencentDB-Agent-Memory（`src/core/{persona,scene,store}`）—— L0–L3 分层金字塔

#### 2.3.1 整体哲学

> "不管是长期的知识、短期的任务、还是未来的经验能力，记忆都不应该平铺，生成和召回都必须有层次。"
> "低层保留证据，高层保留结构；能折叠也能展开，能抽象也能追证。"

长期个性化记忆分四层：
- **L0 Conversation**：原始对话
- **L1 Atom**：结构化事实（约等于本仓的 per-fact 文件）
- **L2 Scenario**：场景块（多个 atom 归纳成一个主题场景）
- **L3 Persona**：用户画像（`persona.md`，从 scenario 提炼）

日常对话只读 L3 persona（信息密度最高），需要证据时下钻 L2 → L1 → L0。

#### 2.3.2 L1→L2：场景抽取（[scene-extractor.ts](file:///c/ai/TencentDB-Agent-Memory/src/core/scene/scene-extractor.ts)）

- 不是规则脚本，而是**派生一个 LLM agent**，sandboxed 到 `scene_blocks/` 目录，用文件读写工具自主管理场景块
- 场景数量上限 `maxScenes`（默认 15），接近上限时 prompt 里会注入分级警告：
  - `sceneCount >= maxScenes`：必须先 MERGE 才能处理新记忆
  - `sceneCount == maxScenes - 1`：本次只能 UPDATE，不能 CREATE
  - `sceneCount >= maxScenes - 3`：建议优先 UPDATE/MERGE
- "软删除"：LLM 不能跑 shell，删除场景的方式是把文件内容写成 `[DELETED]` 标记，外层代码扫描并真正 `unlink`
- 每次 extract 都先 `BackupManager` 备份整个 `scene_blocks/` 目录（可回滚）
- LLM 输出文本里可以嵌入 `[PERSONA_UPDATE_REQUEST]reason: ...[/PERSONA_UPDATE_REQUEST]` 信号，触发下一阶段 persona 更新

#### 2.3.3 L2→L3：persona 生成（[persona-generator.ts](file:///c/ai/TencentDB-Agent-Memory/src/core/persona/persona-generator.ts)）

- 增量模式：对比 `scene_index` 的 `updated` 时间 vs `checkpoint.last_persona_time`，只把**变化过的场景全文**喂给 LLM（而不是全部场景）
- "first" vs "incremental" 两种 prompt 模式
- LLM **直接用工具写 `persona.md`**（而不是返回 JSON 由外层写）——sandboxed 到 `dataDir`
- 写完后程序再做后处理：`stripSceneNavigation()` 去掉 LLM 可能写的导航块，`escapeXmlTags()` 防止 prompt injection，最后追加程序生成的 `generateSceneNavigation()`（从 scene_index 生成的"参见 L2"导航链接）
- 全程 `BackupManager` 备份 + checkpoint 推进

#### 2.3.4 对本仓的启示

- **不要照搬整个 L0-L3 重构**——投入太大，且本仓的 4 类型(user/feedback/project/reference) 平铺模型在中小规模下够用
- 但 **persona.md 这一层性价比很高**：作为 Dream 阶段的*额外*产出（不替换现有 4 类型文件），是对现有 per-fact 文件的**摘要再摘要**，注入成本极低（一两百字），信息密度最高
- "场景数量上限 + 分级警告"这个模式可以用在**Dream 触发条件**上：当 per-fact 文件数接近某个阈值时，prompt 里提示 LLM 优先 merge 而不是 create
- "软删除 + 程序兜底清理"这个安全模式值得借鉴：本仓 Dream 的 `archiveFile()` 已经是直接 `renameSync`（更安全，因为不依赖 LLM 输出文件名正确），**不需要改**

---

### 2.4 hermes-agent（`agent/memory_provider.py` + `plugins/memory/*`）—— Provider 抽象 + 异步 prefetch

#### 2.4.1 Provider 抽象层

[memory_provider.py](file:///c/ai/hermes-agent/agent/memory_provider.py) 定义 `MemoryProvider` ABC，8 个插件实现：mem0、honcho（多轮辩证推理用户建模）、hindsight（知识图谱+实体解析）、holographic（本地 SQLite+FTS5+HRR 组合检索）、byterover、openviking、supermemory、retaindb。

**"one-external-provider limit"**：同时只激活一个外部 provider，防止工具 schema 膨胀和多后端冲突。

#### 2.4.2 关键生命周期钩子（比本仓"会话结束才 summarize"细得多）

| 钩子 | 时机 | 本仓对应 |
|---|---|---|
| `prefetch(query)` / `queue_prefetch(query)` | **每轮提问前**，读缓存的后台预取结果；每轮结束后**异步**为下一轮预取 | ❌ 无，当前是同步 `memory_search` 工具调用 |
| `system_prompt_block()` | 系统提示词组装期 | ≈ MEMORY.md 注入 |
| `sync_turn(user, assistant)` | 每轮结束，非阻塞持久化 | ≈ summarizer，但本仓是会话结束才跑一次 |
| `on_pre_compress(messages)` | **上下文压缩前**，抽取要点 | ❌ 无 |
| `on_session_switch(...)` | `/resume` `/branch` `/reset` 等 session_id 变化 | ❌ 无（本仓 coordinator-worker 多 session 场景可能需要） |
| `on_delegation(task, result, child_session_id)` | 父 agent 观察子 agent 完成 | ❌ 无（本仓有 coordinator-worker，正好能接） |
| `on_memory_write(action, target, content, metadata)` | 内置记忆工具写入时镜像到外部后端 | — |

#### 2.4.3 holographic 后端的 trust score

[holographic README](file:///c/ai/hermes-agent/plugins/memory/holographic/README.md)：本地 SQLite + FTS5 + **trust scoring**（每条 fact 有 `default_trust=0.5` 初始信任分）+ entity resolution + HRR(Holographic Reduced Representation) 组合检索。配套 `fact_feedback` 工具：agent 可以对记忆打 helpful/unhelpful 标签，**反向训练信任分**。

#### 2.4.4 对本仓的启示

- **`prefetch` 异步召回模式**是 P1 里最值得做的——比 claude-code 的同步 `findRelevantMemories` 更优：零延迟（上一轮结束就开始算下一轮要注入什么）
- `on_delegation` 钩子和本仓 [coordinator-worker-manager.ts](../src/main/agent/coordinator-worker-manager.ts) 的架构吻合，可以让 coordinator 把 worker 的产出也计入记忆提取素材
- trust score 是对现有 `recall_count` 的自然升级：`recall_count` 只统计"被检索到几次"，trust score 还要回答"检索到之后真的有用吗"
- Provider 抽象本身工作量很大，**列为 P3，仅作架构方向参考，不建议短期投入**

---

### 2.5 codex（`codex-rs/ext/memories/`）—— 纯文件 + 精细 grep（极简对照组）

文件：[lib.rs](file:///c/ai/codex/codex-rs/ext/memories/src/lib.rs)、[search.rs](file:///c/ai/codex/codex-rs/ext/memories/src/local/search.rs)

只暴露 4 个工具：`list` / `read` / `search` / `add_ad_hoc_note`。**完全没有向量、没有 BM25**——纯子串匹配，但匹配能力做得很细：

- 多 query 同时匹配，三种模式：`Any`（任一行匹配任一 query）、`AllOnSameLine`（同一行匹配所有 query）、`AllWithinLines{n}`（n 行滑窗内匹配所有 query，且去除被其他窗口完全包含的子窗口）
- `case_sensitive` / `normalized`（忽略非字母数字字符）两个开关
- `context_lines` 上下文行、`cursor` 分页（`MAX_SEARCH_RESULTS=200`）
- 安全：拒绝符号链接、路径限定在 `backend.root` 内
- 协议层有 `MemoryCitation` / `MemoryCitationEntry`，记忆引用可在 UI 里溯源高亮

**对本仓的启示**：这是"反向参考"——证明**即使完全不上向量/BM25，把纯文本检索做精细（多 query + 滑窗 + 分页）也能用**。如果 P0-b（向量检索）评估后投入产出不划算，至少应该把现有 LIKE 检索升级到类似 codex 的"多 query AND 窗口匹配"逻辑，成本很低。`MemoryCitation` 概念也值得借鉴：检索结果里带上"这条记忆来自哪个 session/对话"的引用，方便用户在 UI 里点击溯源（本仓 [MemoryPanel.tsx](../src/renderer/src/components/customize/MemoryPanel.tsx) 已经有记忆管理面板，可以加这个）。

---

### 2.6 MiMo-Code（opencode 分支，`packages/opencode/src/memory/`）—— Scope 模型 + Auto-Dream/Distill

#### 2.6.1 Scope 模型（[paths.ts](file:///c/ai/MiMo-Code/packages/opencode/src/memory/paths.ts)）—— **本仓 P0-a 的最佳参照**

```ts
type Scope = "global" | "projects" | "sessions" | "cc"
// 物理路径：<root>/memory/{global | projects/<id> | sessions/<id>}/<key>.md
resolveProjectId = sha256(absRepoPath).digest("hex").slice(0, 12)
```

- `global`：跨项目用户事实（角色、偏好）—— 路径下不带 `scope_id`
- `projects/<id>`：单仓库专属事实，`id` 是仓库绝对路径的 sha256 前 12 位（不是 sanitize 路径名，避免特殊字符/大小写问题，且不暴露真实路径）
- `sessions/<id>`：单会话临时记忆（本仓当前完全没有这一层）
- `cc`：**桥接**模式——`parseCcPath()` 能识别 claude-code 的 `~/.claude/projects/<slug>/memory/<key>.md` 布局，`parseCcFrontmatterType()` 从 frontmatter 的 `metadata.type` 字段识别类型。这是为了让 MiMo 的记忆系统能**索引并复用 claude-code 已经写好的记忆文件**，而不是另起一套
- `buildPath()` 有路径穿越防护：拒绝 `..` 段和绝对路径注入

#### 2.6.2 SQLite FTS5 + 相对分数地板（[service.ts](file:///c/ai/MiMo-Code/packages/opencode/src/memory/service.ts)）

检索 SQL 支持按 `scope` / `scope_id` / `type` 过滤（正好对应作用域分层后的查询需求）：

```sql
SELECT ..., bm25(memory_fts_idx) AS score FROM memory_fts_idx
JOIN memory_fts ON ... WHERE memory_fts_idx MATCH ?
  [AND scope = ? AND scope_id = ? AND type = ?]
ORDER BY score LIMIT ?
```

**相对分数地板**（`memory_search_score_floor`，默认 0.15）：FTS5 query 用 OR 连接多个 token，会导致"只命中一个常见词"的文档也进结果集。解决方案不是固定绝对分数阈值（小语料库 BM25 分数普遍很小，固定阈值会误杀），而是**相对 top1 分数的比例**——保留分数 ≥ `top1Score * 0.15` 的结果，且 top1 永远保留。over-fetch 3x（cap 50）给地板过滤留余量。

#### 2.6.3 增量索引/reconcile（[reconcile.ts](file:///c/ai/MiMo-Code/packages/opencode/src/memory/reconcile.ts)）

- `walkMemoryDir()` 递归扫描所有 `.md`；`walkCcRoot()` 额外扫描所有 `<slug>/memory/` 子目录（桥接 cc）
- 用 `${size}-${mtimeMs}` 作为 fingerprint，和已索引记录比较，三态返回：`hit`(无变化)/`updated`/`skipped`
- **双 root 同时 walk 后再 prune**——避免"只开 cc 索引时把所有 mimo 记录当作死记录清掉"这种方向性 bug
- 懒重建：`memory_reconcile_on_search` 配置项，可以在每次 search 前先 reconcile，覆盖"工具外部直接改了文件"的场景

#### 2.6.4 Auto-Dream / Auto-Distill（[auto-dream.ts](file:///c/ai/MiMo-Code/packages/opencode/src/session/auto-dream.ts)）

两个独立的周期性后台任务，都通过**派生一个真实 agent session**（不是单次 LLM 调用）执行：

- **Dream**（默认 7 天一次）：`"Use the memory files as the working index and the raw mimocode trajectory database as the source of truth. Use bash for read-only SQLite ... Consolidate only durable, verified information into project memory."`
- **Distill**（默认 30 天一次）：`"Review the past month of sessions and identify repeated manual workflows worth packaging ... Inventory existing skills, agents, and commands first so you reuse or extend instead of duplicating."`

触发条件：`shouldAutoRun()`——项目"年龄"够大（首次运行前检查最早 session 是否已超过 interval）、距上次运行间隔够长、最小 spawn 间隔 `MIN_SPAWN_GAP_MS=10s` 防抖。

#### 2.6.5 对本仓的启示

- **Scope 模型直接可抄**：`global` / `projects/<id>` 两层（先不做 `sessions`/`cc`），`resolveProjectId = sha256(gitRoot)` 比 sanitize 路径名更干净，本仓 TODO 里写的"sanitizePath 替换非字母数字字符"方案不如这个
- 现有 `search()` 函数签名加 `scope`/`scope_id` 过滤参数，SQL `WHERE` 子句直接照抄
- **相对分数地板**是本仓 LIKE 检索可以立即受益的小改动：当前 `score > 0` 就收录，命中数多时会让一堆"只命中一个 bigram"的弱相关结果挤占 top-N
- **Distill** 这个维度和本仓已有的 [skill-evolution/](../src/main/agent/skill-evolution/) 模块强相关——"记忆系统发现重复工作流 → 生成 skill"是两个模块的天然交汇点，值得在 P2+ 阶段统一规划

---

## 3. 横向对比矩阵

| 维度 | 当前(本仓) | claude-code | openclaw | TencentDB | hermes | codex | MiMo-Code |
|---|---|---|---|---|---|---|---|
| 存储格式 | md+frontmatter+SQLite索引 | md+frontmatter+manifest | SQLite+vec | DB+md(分层) | 后端各异 | 纯 md 文件 | md+SQLite FTS5 |
| 检索算法 | BM25(FTS3)+LIKE/bigram | 小模型语义选择 | 向量+BM25+RRF+MMR+时间衰减 | BM25+向量+RRF | 各后端不同(含HRR) | 多模式子串匹配 | BM25(FTS5)+相对地板 |
| 召回时机 | 被动(工具+索引常驻) | **主动**(查询时同步选择) | 工具 | 自动 | **异步预取** | 工具(模型驱动) | 被动 |
| 作用域分层 | ❌ 全局单池 | global/team 两层 | 未见明确分层 | 无显式作用域 | provider 自定 | 目录层级 | **global/projects/sessions/cc 四层** |
| 高层抽象 | ❌ 4类型平铺 | 平铺 | 平铺 | **L0→L3 金字塔+persona** | provider 自定 | 平铺 | 平铺 |
| 整合机制 | Dream(7天,LLM单次调用) | — | dreaming(多阶段) | scene/persona 增量更新 | 无统一 | — | **Dream+Distill(spawn agent session)** |
| 反馈信号 | recall_count | — | — | recall_count(场景heat) | **trust score(可训练)** | citation | — |
| 安全机制 | archive而非删除, path-traversal guard | — | — | 备份+软删除+程序兜底 | — | 符号链接拒绝+root限定 | path-traversal guard |

---

## 4. 优化建议详述

### P0-a：工作区记忆隔离

**目标**：解决 §1.5 的跨项目污染问题。

**实现要点**（融合 MiMo-Code Scope 模型 + 本仓现有 TODO 思路）：

1. 路径结构改为：
   ```
   ~/.cmbcoworkagent/memory/
     global/                  # 现有 4 类型文件 + MEMORY.md，跨项目通用
       MEMORY.md
       user_xxx.md
       feedback_xxx.md
     projects/
       <sha256(gitRoot)[:12]>/
         MEMORY.md
         project_xxx.md
         feedback_xxx.md       # 项目专属的 feedback 也可以落在这里
   ```
2. `getProjectMemDir(workDir)`：复用本仓已有的 `findCanonicalGitRoot`（worktree 解析到主仓库）+ `sha256().slice(0,12)`，无 git 仓库时 fallback 到 global-only
3. **注入策略**：system prompt 注入 `global/MEMORY.md` + `projects/<id>/MEMORY.md`（两份都在 200 行/25KB 限制内，合计可控）；`memory_search`/`memory_get` 工具默认搜两个 scope，可加 `scope` 参数限定
4. **summarizer 分流**：LLM operations 里新增/沿用 `type` 字段判断落盘位置——`user` 类型默认写 global；`project`/大部分 `feedback` 写 projects/<id>；`reference` 视内容（外部系统通常是项目专属）
5. **迁移**：现有 `~/.cmbcoworkagent/memory/*.md` 一次性迁移为 `global/`（保守选择——宁可信息冗余在 global，也不要丢失）
6. Dream 整合按 scope 分别运行（global 一份状态，每个 project 一份状态），互不干扰

**风险**：低。存储格式（frontmatter/manifest/搜索逻辑）不变，只是多一层目录和"按 scope 选目录"的路径解析逻辑。主要改动面：`store.ts` 的 `MEMORY_DIR` 解析、`runtime.ts` 的注入点（变成两份 MEMORY.md）、`summarizer.ts`/`consolidate.ts` 的 scope 参数、`ipc/memory.ts`/`ipc/terminal.ts` 的路径常量、[MemoryPanel.tsx](../src/renderer/src/components/customize/MemoryPanel.tsx) 的 UI 切换。

---

### P0-b：混合检索升级（RRF + 向量语义）

**目标**：解决中文 bigram+LIKE 的同义召回缺失（"用户喜欢什么口味"搜不到"他不吃辣"）。

**实现要点**（融合 openclaw 融合公式 + MiMo-Code 相对地板 + codex 多模式匹配作为低成本垫底）：

1. **存储**：sql.js 加一张 `chunk_embeddings(chunk_id, vector BLOB)` 表，或评估 `sqlite-vec` 扩展是否能在 sql.js(WASM) 环境跑通（若不行，向量相似度在 JS 里算 cosine 即可，chunk 数量级通常不大）
2. **Embedding provider**：参照 openclaw 的 provider 抽象，优先支持本仓已配置的模型网关（OpenAI 兼容接口），允许配置专门的 embedding 模型；本地/离线场景可选 Ollama embedding 作为兜底
3. **融合公式**：照搬 openclaw `mergeHybridResults`：
   ```
   score = vectorWeight * cosineScore + textWeight * bm25Score(归一化后)
   ```
   初始权重建议 0.5/0.5，后续可调
4. **小成本优先项**（即使向量检索暂不落地也能做）：
   - MiMo-Code 的**相对分数地板**（top1 score * 0.15），过滤当前 LIKE 检索里大量"只命中一个 bigram"的弱相关结果
   - codex 的**多 query + 滑窗匹配**模式，作为 `memory_search` 工具内部检索的精细化补充
5. **时间衰减**（openclaw）：可选叠加，但要小心 — 本仓已有 `memoryFreshnessText()` 在展示层做"过期提醒"，时间衰减是在排序层做加权，两者可以共存但语义要理清楚（哪个负责"排序"，哪个负责"提示用户验证"）

**风险**：中。需要新增 embedding 调用（额外的 LLM 网关请求、延迟、成本），且要处理"用户未配置 embedding 模型"时的降级（纯 BM25+LIKE，即当前行为）。建议先做"小成本优先项"验证收益，再决定是否上向量。

---

### P1：异步 prefetch 召回

**目标**：把"被动等 agent 调 memory_search"升级为"后台预取，本轮直接可用"，零延迟。

参照 hermes `prefetch()`/`queue_prefetch()`：每轮 agent 回复完成后，后台用本轮最后一条用户消息作为 query 异步跑一次 `memory_search`（P0-b 升级后的检索），结果缓存；下一轮组装 system prompt / context 时直接附加缓存结果（若还没算完就跳过，不阻塞）。

可选叠加 claude-code 的"recentTools 去噪"——排除当前正在使用的工具对应的 reference 类记忆。

---

### P2：persona 高层抽象 + trust 反馈

两个独立的小改动，都是在现有机制上**叠加**，不替换：

- **persona.md**：Dream 阶段（[consolidate.ts](../src/main/memory/consolidate.ts)）增加一个新的 LLM 调用，输入 = 现有 per-fact 文件（尤其 user/feedback 类），输出 = 更新后的 `persona.md`（200-500 字的高层用户画像）。日常注入时 persona.md 可以替代/补充 MEMORY.md 的"User"分组部分
- **trust score**：在 `chunks` 表给 `recall_count` 旁边加 `helpful_count` / `unhelpful_count`，`memory_get` 工具调用后可选地让 agent 标注这条记忆是否真的有帮助（也可以是事后由 summarizer 在下一轮根据对话是否采纳该记忆来打分，避免额外工具调用打断流程）。Dream 决策时优先 archive `unhelpful_count` 高的记忆

---

### P3（架构方向，不建议短期投入）

Provider 抽象层——若未来要支持外部记忆服务（如 mem0），可参照 hermes 的 `MemoryProvider` ABC 设计一层适配接口。当前本仓的内置实现已经覆盖核心需求，重构成本与收益不成比例，列为远期方向。

---

## 5. 与现有调研文档的关系

| 文档 | 范围 | 关系 |
|---|---|---|
| [memory-tdai-research.md](./memory-tdai-research.md) | 单次长任务的上下文压缩链路 vs TencentDB offload | 互补——offload 解决"一次任务内"的 token 问题，本文解决"跨会话"的记忆问题 |
| [memory-tdai-feasibility.md](./memory-tdai-feasibility.md) | TencentDB 任务画布(Mermaid)可行性 | 同上，且该文档明确写了"长期记忆 L0–L3 不在本文范围"——本文正是补这块 |
| 本文 | 长期记忆：作用域、检索、分层 | — |

两条线（短期上下文卸载 / 长期记忆系统）目前互不阻塞，可并行推进。

---

## 6. 市面主流方案二轮调研（2026-06）

本节补充本地六个参考工程之外的主流技术路线。资料口径以官方文档、论文、项目 README 为主；博客中的 benchmark 数字只作为趋势参考，不作为本仓选型的唯一依据。

### 6.1 Mem0 —— drop-in memory layer，ADD-only + 多信号检索

资料：
- Mem0 官网/文档：<https://mem0.ai/>、<https://docs.mem0.ai/>
- OSS v3 迁移文档：<https://docs.mem0.ai/migration/oss-v2-to-v3>
- 论文：<https://arxiv.org/html/2504.19413v1>

**核心设计**：
- 对外 API 很薄：`add` / `search` / `get_all` / `get` / `update` / `delete`，适合被 agent framework 当成 provider 接入。
- OSS v3 把抽取改成 **single-pass ADD-only**：热路径只追加新事实，不在抽取阶段做复杂 UPDATE/DELETE；冲突、合并、过期更多交给后续检索和整合层。
- 检索改成 **multi-signal hybrid search**：语义相似度 + BM25 关键词 + entity matching，并支持 entity linking、metadata filtering、reranker、async memory。
- 同时提供 managed platform、OSS、自托管 REST server、MCP server、多框架集成（LangGraph、OpenAI Agents、Claude Code/Cursor/OpenClaw 等）。

**对本仓的启示**：
- 本仓 summarizer 当前一次调用同时做 `create/update/skip + MEMORY.md rewrite`，工程上已经可用，但 prompt 负担偏重。可以考虑把"会话结束抽取"拆成两档：
  - **热路径 ADD-only**：只追加高置信事实，尽量不改旧文件；
  - **Dream 冷路径**：负责 merge/archive/update index。
- Mem0 的 `add/search` API 形态可作为未来 P3 provider 抽象的最小接口，但短期不建议把本地记忆直接迁到 Mem0 服务；金融/内网场景下，默认本地文件可审计仍然更稳。
- Entity linking 很值得轻量化吸收：先不建图数据库，只在 frontmatter 增加 `entities: []` / `source_thread_id` / `source_turn_id`，为后续图化或引用溯源铺路。

### 6.2 Zep / Graphiti —— temporal context graph，而不是"更大的向量库"

资料：
- Graphiti 文档：<https://help.getzep.com/graphiti/getting-started/overview>
- Zep concepts：<https://help.getzep.com/concepts>
- Zep facts：<https://help.getzep.com/facts>
- Graphiti GitHub：<https://github.com/getzep/graphiti>
- 论文：<https://arxiv.org/html/2501.13956v1>

**核心设计**：
- 记忆单位不是孤立文本块，而是 **Context Graph**：entity node + fact/relationship edge + episode provenance。
- 每条 fact 保留时间语义：何时创建、何时生效、何时失效；新事实可以 invalidate 旧事实，但保留历史。
- Graphiti 强调动态数据：增量 ingest episode，不需要像传统 GraphRAG 那样定期批处理重建。
- 检索是 **vector similarity + BM25 + graph traversal** 的混合排名，且 retrieval 阶段不依赖 LLM rerank；Zep 进一步包装成可直接注入 prompt 的 context block。
- 支持 custom entity / edge types，适合业务对象丰富、关系复杂、时间变化频繁的企业场景。

**对本仓的启示**：
- 不建议短期引入 Neo4j/FalkorDB/Neptune 这类图后端；本仓记忆规模和桌面形态不值得先背这个运维成本。
- 但 Zep 的 **valid/invalid fact lifecycle** 很适合本仓：当前仅有 `mtime + freshness caveat`，无法表达"这条决策已被后来的事实废弃"。可在 frontmatter 增加：
  ```yaml
  source_thread_id: "..."
  source_turn_id: "..."
  valid_from: "2026-06-15"
  invalidated_at: null
  invalidated_by: null
  entities: ["auth", "pnpm", "memory"]
  ```
- Dream archive 也可以改为"先标记 invalidated，再移动 archive"：这样检索层能解释为什么旧事实不再默认注入，UI 也能展示事实演变链路。

### 6.3 LangGraph / LangMem —— namespaces + semantic/episodic/procedural 三分法

资料：
- LangGraph memory concepts：<https://docs.langchain.com/oss/python/concepts/memory>
- LangMem 发布说明：<https://www.langchain.com/blog/langmem-sdk-launch>

**核心设计**：
- LangGraph 区分短期记忆（thread-scoped checkpoint）和长期记忆（custom namespaces）。
- 长期记忆按人类记忆范式拆成：
  - **semantic**：事实和知识；
  - **episodic**：经历/事件；
  - **procedural**：规则、偏好、行为策略。
- 记忆更新有两种时机：hot path（回复前/回复中更新）和 background（异步抽取/整合）。官方文档明确提示这两者是工程权衡，不存在一刀切。
- LangMem 进一步提供事实抽取、行为优化、prompt 更新等工具，并能接入任意存储系统。

**对本仓的启示**：
- 本仓现有 `user/project/reference/feedback` 类型可以映射为：
  - `user/project/reference`：主要是 semantic；
  - `feedback`：主要是 procedural；
  - raw conversation / trace / task-mmd：episodic 证据源，不宜全部变成长期 fact。
- P0-a 的 `global/` + `projects/<id>/` 本质上就是 LangGraph namespace，应把术语统一为 **scope/namespace**，便于后续接 provider。
- 记忆抽取和注入应显式拆时机：
  - 会话结束：background extraction；
  - 每轮开始：background prefetch 的上轮结果；
  - 压缩前：on_pre_compress，抽取当前任务关键状态；
  - Dream：cold-path consolidation。

### 6.4 Letta / MemGPT —— core memory block + recall + archival 的 OS 分层

资料：
- Letta docs：<https://docs.letta.com/guides/get-started/intro>
- Agent memory 介绍：<https://www.letta.com/blog/agent-memory/>
- filesystem benchmark：<https://www.letta.com/blog/benchmarking-ai-agent-memory/>

**核心设计**：
- MemGPT/Letta 用类操作系统的 memory hierarchy：有限的 core memory 常驻上下文，外部 recall/archival memory 通过工具按需取回。
- Core memory 是可编辑 block：每个 block 有 label、description、value、character limit，可由 agent 或 sleep-time memory agent 更新。
- Recall memory 保存完整对话历史；archival memory 保存显式加工过的知识，可用向量库/图数据库等后端。
- Letta Code 新路线还提到 git-tracked MemFS，说明"文件系统记忆 + agent 自编辑"仍然是主流可行路线，不是落后方案。

**对本仓的启示**：
- `MEMORY.md` 不应该无限膨胀为"大索引常驻"。更优形态是：
  - `persona.md` / `preferences.md` / `project_brief.md` 作为 core memory block 常驻；
  - per-fact 文件作为 archival memory；
  - `memory_search` / prefetch 作为 recall/archival retrieval。
- Core block 需要 character limit 和优先级，而不是简单按文件全文注入。
- Agent 自编辑记忆工具要谨慎开放。本仓已有 summarizer/Dream 两道 LLM 写入关口，短期比让主 agent 直接任意写 memory 更可控。

### 6.5 LlamaIndex Memory Blocks —— 静态块、事实抽取块、向量块 + priority token budget

资料：
- Python memory docs：<https://developers.llamaindex.ai/python/examples/memory/memory/>
- TypeScript memory docs：<https://developers.llamaindex.ai/typescript/framework/modules/data/memory/>

**核心设计**：
- 长期记忆被抽象为 Memory Block：`StaticMemoryBlock`、`FactExtractionMemoryBlock`、`VectorMemoryBlock`。
- 每个 block 有 priority。priority 0 永远保留；priority 越高，在超过 token limit 时越先被暂时禁用。
- retrieval 时短期记忆和长期记忆被合并，并按 token limit、short-term ratio、block priority 裁剪。

**对本仓的启示**：
- 本仓当前 prompt 注入只有"MEMORY.md 全文 + agent 可选搜细节"，缺少正式 token budget/priority。建议引入注入优先级：
  1. `persona.md` / `project_brief.md`：P0 常驻，极小；
  2. `global/MEMORY.md` + `project/MEMORY.md`：P1 常驻，硬限制；
  3. prefetch Top-K snippets：P2，有结果才注入；
  4. raw episodic context / trace 摘要：P3，只在相关任务注入。
- 这比"一刀切 200 行/25KB"更稳，尤其当 P0-a 后要同时注入 global + project 两份索引。

### 6.6 向量/混合检索基础设施：桌面本地优先

资料：
- sqlite-vec：<https://github.com/asg017/sqlite-vec>
- SQLite-Vector：<https://www.sqlite.ai/sqlite-vector>
- LanceDB hybrid search：<https://docs.lancedb.com/search/hybrid-search>
- pgvector：<https://github.com/pgvector/pgvector>

| 方案 | 适配本仓桌面形态 | 优点 | 风险/代价 | 建议 |
|---|---:|---|---|---|
| **JS cosine + SQLite BLOB 表** | 高 | 不加 native 依赖；sql.js 现状可直接做；小规模足够 | O(n) 扫描，依赖 embedding provider | **P0-b 首选起步** |
| **sqlite-vec** | 中 | SQLite 扩展，支持 float/int8/binary vector，跨平台/WASM，Node 可用 | pre-v1；本仓用 sql.js，扩展加载/打包要验证 | P1 实验 |
| **SQLite-Vector** | 中 | 普通表 BLOB、低内存、WASM/移动/桌面友好 | 生态成熟度和许可证/打包需评估 | P1 实验 |
| **LanceDB** | 中 | 原生 hybrid search + reranker，默认 RRF，TypeScript 示例完善 | Electron 打包、磁盘格式、native/arrow 依赖风险 | 语料上万后再评估 |
| **pgvector** | 低 | HNSW/IVFFlat、Postgres 生态、生产级扩展 | 需要数据库服务，不适合默认桌面本地 | 企业部署/服务端模式再考虑 |
| Qdrant/Milvus/Weaviate/Chroma | 低-中 | 成熟向量库，生态好 | 额外服务或运行时，增加安装/运维 | 不作为默认方案 |

**关键判断**：本仓长期记忆不是百万级文档 RAG，默认是几十到几千条 per-fact/chunk。P0-b 没必要先引入向量数据库；用 `chunk_embeddings(chunk_id, model, dim, vector_blob)` + JS cosine 就能验证"语义召回是否真的提升"。等记忆规模、性能数据、打包约束都明确后，再决定 sqlite-vec/LanceDB。

### 6.7 RRF / MMR / rerank：比单一 score 更重要

LanceDB 默认用 RRF（Reciprocal Rank Fusion）合并语义检索和全文检索结果；Graphiti/Zep 也走 hybrid search + reranker。对本仓来说，RRF 比简单加权更适合作为第一版融合公式，因为当前三类分数尺度完全不同：

- FTS3 BM25：越大越相关（本仓自算）；
- LIKE/bigram：整数命中数；
- cosine：0-1 或 -1-1。

建议 P0-b 的融合顺序：
1. 每一路先独立取 topK；
2. 按名次算 RRF：`1 / (k + rank)`，`k=60` 是常见起点；
3. 同一 chunk 合并多路分数；
4. 再叠加轻量信号：scope 权重、freshness、trust/helpful、exact filename/type 命中；
5. 最后可选 MMR，避免 top5 全是同一文件的重复 chunk。

---

## 7. 对本仓优化路线的修正

### 7.1 P0-a 仍是第一优先：scope/namespace 是所有方案共识

外部方案虽然实现差异很大，但都避免"所有主体共用一个记忆池"：
- Mem0 以 `user_id` / filters 隔离；
- Zep 有 user graph / graph / group 维度；
- LangGraph 用 custom namespaces；
- MiMo-Code 用 `global/projects/sessions`。

因此本仓 P0-a 不只是本地 TODO，而是长期记忆系统的基本正确性。建议落地时术语直接采用：

```ts
type MemoryScope = "global" | "project"
type MemoryNamespace = { scope: "global" } | { scope: "project"; projectId: string; gitRoot: string }
```

### 7.2 P0-b 改成"检索质量框架"，向量只是其中一路

原 P0-b 容易被理解为"上向量库"。二轮调研后建议改成：

1. 先加相对分数地板、多 query 窗口、RRF 框架；
2. 再接 embedding provider + JS cosine；
3. 最后再评估 sqlite-vec / LanceDB。

这样即使用户没有 embedding 模型，词法检索也能变好；有 embedding 时，只是多一路 signal。

### 7.3 新增 P0-c：记忆评测集与可溯源引用

在做向量/混合检索前，必须有一个小型 regression suite，否则"感觉更智能"很难验证。建议新增 `tests/memory-retrieval.spec.ts`：

- 中文同义：`不吃辣` 能被 `口味偏好` / `能不能吃辣` 召回；
- 项目隔离：A 项目的 `pnpm` 事实不会进入 B 项目；
- 过期事实：新事实 invalidates 旧事实时，旧事实不默认注入；
- 反馈类 procedural：`不要 mock DB` 能被 `怎么写测试` 召回；
- 引用溯源：每个结果返回 `file + lines + source_thread_id`。

这条投入很小，但能保护 P0-a/P0-b 不走偏。

### 7.4 P1 从"主动/异步召回"扩展为"Context Assembly"

市场方案的重点已经从"搜到什么"升级为"如何组装给模型"。建议 P1 改为一个明确的 context assembly 层：

```txt
assembleMemoryContext(query, namespace, budget)
  -> core blocks: persona/project_brief
  -> indexes: global/project MEMORY.md
  -> prefetched snippets: RRF Top-K
  -> citations/freshness/invalidated warnings
```

这个函数成为 runtime/system-prompt 注入的唯一入口，避免 `runtime.ts`、`tools.ts`、`ipc/memory.ts` 各自拼 memory 逻辑。

### 7.5 P2 图记忆不照搬，先做 lightweight entity/provenance

Graphiti/Zep 的完整 temporal graph 很强，但本仓短期更适合先加 metadata：

- `entities: string[]`
- `source_thread_id`
- `source_message_ids`
- `created_from: "summarizer" | "dream" | "manual"`
- `valid_from`
- `invalidated_at`
- `invalidated_by`

检索时先用 entity token 做加分；Dream 时用 `invalidated_by` 建事实演变链。等数据量和需求证明需要多跳关系，再考虑 Graphiti/Zep provider。

### 7.6 P3 Provider 抽象保持远期，但接口可以先对齐

短期不做外部 provider 重构，但新增内部 API 时可以向主流方案靠拢：

```ts
interface MemoryProvider {
  add(input: MemoryAddInput): Promise<MemoryAddResult>
  search(input: MemorySearchInput): Promise<MemorySearchResult[]>
  get(input: MemoryGetInput): Promise<MemoryDocument | null>
  consolidate?(input: MemoryConsolidateInput): Promise<MemoryConsolidateResult>
  assembleContext?(input: MemoryContextInput): Promise<string>
}
```

默认实现仍然是本地 markdown + SQLite；Mem0/Zep/Graphiti 未来只做可选 provider，不影响默认隐私和离线可用性。

---

## 8. 建议落地切片

### Slice 1：检索质量无模型增强（0.5-1 天）

- LIKE/FTS 结果 over-fetch 3x；
- 加相对分数地板；
- 多 query AND-window 检索；
- search result 增加 score/source/citation；
- 单测覆盖中文同义的词法下限、空查询、弱相关过滤。

收益：不引入 embedding，不改存储路径，也能立刻减少噪音结果。

### Slice 2：scope/namespace 隔离（1-2 天）

- 新增 `paths.ts`：`getGlobalMemoryDir()`、`getProjectMemoryDir(workDir)`、`resolveMemoryNamespace()`；
- 迁移旧 `~/.cmbcoworkagent/memory/*.md` 到 `global/`；
- runtime 注入 global + project；
- summarizer 按 type/namespace 分流；
- MemoryPanel 增加 scope 切换；
- Dream state 按 namespace 分开。

收益：解决跨项目污染，是最高确定性收益。

### Slice 3：RRF + embedding provider（2-4 天）

- 新增 `chunk_embeddings` 表；
- 配置 embedding model（复用 OpenAI-compatible baseUrl/apiKey，允许单独配置）；
- touched chunk 异步补 embedding；
- `search()` 改成 FTS/LIKE/vector 三路 topK + RRF；
- embedding 缺失时自动降级纯词法；
- 加 `memory:rebuildEmbeddings` 管理入口。

收益：补中文同义、语义意图召回短板；风险主要是模型配置和成本。

### Slice 4：Context Assembly + prefetch（2-3 天）

- 新增 `assembleMemoryContext()`；
- core blocks：`persona.md` / `project_brief.md`；
- 上轮结束后台 prefetch，下轮直接注入；
- token budget/priority；
- stale/invalidated/citation 统一格式。

收益：从"工具被动搜"升级到"系统主动提供相关记忆"，但不阻塞前台回复。

### Slice 5：provenance / invalidation / trust（2-4 天）

- frontmatter 增加 source/validity/trust 字段；
- `memory_search` 返回引用和有效期；
- Dream 支持 invalidated 标记；
- helpful/unhelpful 反馈或自动推断；
- UI 展示"来源会话/已过期/被哪条事实替代"。

收益：解决长期记忆最难的"旧事实误导"问题。

---

## 9. 二轮结论

市面主流方案的共同方向很清楚：

1. **Scope first**：没有隔离的记忆系统一定会污染。
2. **Hybrid retrieval**：BM25/关键词/向量/entity/graph 是互补信号，不要押宝单一路径。
3. **Core memory blocks**：常驻上下文应该是小而稳定的画像/项目摘要，不是越来越大的全文索引。
4. **Temporal/provenance**：长期记忆必须知道来源、有效期、是否被新事实废弃。
5. **Background consolidation**：热路径轻量追加，冷路径合并、归档、抽象。
6. **Local-first for desktop**：本仓默认方案应继续是本地文件 + SQLite，可选外部 provider 只能作为扩展。

因此最终建议路线是：

```txt
P0-a scope/namespace 隔离
  -> P0-c 记忆检索评测 + citation
  -> P0-b RRF 混合检索（先词法增强，再 JS cosine 向量）
  -> P1 Context Assembly + async prefetch
  -> P2 persona/core blocks + provenance/invalidation/trust
  -> P3 可选 provider（Mem0/Zep/Graphiti）
```

这条路线既吸收了 Mem0/Zep/Letta/LangGraph/LlamaIndex 的主流思想，又保留本仓当前最宝贵的优势：**本地、透明、可审计、可被 agent 和用户直接查看/修改的 markdown 记忆文件**。
