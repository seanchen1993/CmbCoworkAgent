# CMBDevClaw Git 全链路技术参考（性能重点）

更新时间：2026-04-17  
适用版本：当前仓库 `src/main/ipc/git.ts` + `src/main/ipc/models.ts` + Git Panel 相关实现。  
文档目标：从“Git 全操作”而不是“仅 commit/push”视角，梳理本项目的技术架构与性能设计。

---

## 1. 范围与结论

本文覆盖本项目以下 Git 操作：
- 仓库探测（是否 Git 仓库、是否 worktree、获取 git root）
- 状态获取（`git-status`、GitPanel 摘要）
- 分支操作（当前分支、分支列表、切换、创建）
- Worktree 操作（列举、创建、删除、上下文保存）
- 提交/推送/拉取（`commitWorktree` / `pushWorktree` / `pullWorktree`）
- 回退（按文件回退、全部回退）

核心结论：
- 本项目 Git 性能优化不是单点优化，而是“子进程治理 + 缓存 + 并发 + 快速路径 + 内存保护”的组合。
- 高收益优化集中在三处：
  1. `git-status` 从多命令变为单命令解析。
  2. GitPanel 大 diff 场景从串行变为限流并发。
  3. 分支/HEAD/摘要等高频信息采用短 TTL + Promise 去重缓存。

---

## 2. Git 架构分层

### 2.1 基础 Git IPC 层（`src/main/ipc/git.ts`）

职责：
- 提供通用 Git IPC（状态、分支、执行受限命令）。
- 提供 Git 子进程队列限流、超时策略、锁冲突清理等“运行时治理”。

典型入口：
- `git-status`
- `execute-git-command`
- `git:currentBranch`
- `git:listBranches`
- `git:switchBranch`
- `git:createBranch`

### 2.2 GitPanel/工作区层（`src/main/ipc/models.ts`）

职责：
- 提供与线程上下文绑定的 Git 工作流（worktree、commit/push/pull/reject）。
- 负责面板级状态构建（文件 diff、统计、可推送判断、待推送 commit 列表）。

典型入口：
- `workspace:isGit`
- `workspace:listWorktrees` / `workspace:createWorktree` / `workspace:removeWorktree`
- `workspace:getGitPanelState` / `workspace:getGitPanelSummary`
- `workspace:commitWorktree` / `workspace:pushWorktree` / `workspace:pullWorktree`
- `workspace:rejectWorktreeChanges` / `workspace:rejectWorktreeFile`

---

## 3. 性能目标与瓶颈模型

### 3.1 主要性能目标
- 降低 Git 子进程数量（spawn 次数）。
- 降低面板首屏与刷新时延（尤其是大 diff 场景）。
- 避免主进程因大文件/大仓库扫描而出现内存和 IO 抖动。
- 在保证可用性的前提下减少网络相关步骤对主流程的阻塞。

### 3.2 常见瓶颈
- 同一时刻重复读取分支/HEAD/root（高频轮询导致命令风暴）。
- 逐文件 diff 串行计算（N 个文件线性累积等待）。
- 新增大文件时直接读全文生成 diff（内存压力高）。
- 状态计算依赖多条 Git 命令（上下文切换和进程开销大）。

---

## 4. 核心性能机制

### 4.1 Git 子进程治理：异步化 + 限流

实现点：`src/main/ipc/git.ts`
- 全部使用 `execFile` 异步执行，避免主进程同步阻塞。
- 通过 `withGitCommandQueue` 串行化 Git 命令（`MAX_GIT_COMMAND_CONCURRENCY=1`），减少锁争用与 IO 争抢。
- 按命令类型设置超时：`push > pull/fetch > 本地命令`。

收益：
- 在多入口并发触发时，整体响应更稳定，失败率更低。

### 4.2 `git-status` 单命令化

实现点：`getGitStatus` + `parsePorcelainStatus`
- 旧路径（多次 `diff/ls-files/...`）改为一次 `status --porcelain` 解析。
- 优先 `-z`（NUL 分隔）避免路径解析歧义，降级到行分隔格式时仍保持单命令。
- 使用本地分类逻辑一次性构建 `changed/untracked/staged`。

收益：
- 减少子进程次数，显著降低状态读取延迟。

### 4.3 缓存体系：短 TTL + Promise 去重

实现点：`getCachedPromise`
- 缓存 Promise（不是值），可合并同一时刻并发请求，避免缓存击穿。
- 缓存项：`gitRootCache`、`worktreeCache`、`summaryCache`、`branchCache`、`headCommitCache`。
- TTL 采用 1 秒短缓存，重点吸收 UI 高频读，降低陈旧风险。

收益：
- 高频读取分支/HEAD/root/summary 场景明显减少重复 Git 命令。

### 4.4 并发策略：可并发步骤并行、重任务限流并发

实现点：`src/main/ipc/models.ts`
- `Promise.all` 并行：
  - `getPushabilitySnapshot` 中的 `rev-list --count` 与 `log`。
  - `buildGitPanelFileDiff` 中 `diff` 与 `numstat`。
  - `resolveThreadWorkspaceContext` 中 `getGitRoot` 与 `detectIsWorktreePath`。
  - `createWorktree` 时 base branch/base commit 读取。
- `mapWithConcurrencyLimit`：GitPanel 逐文件 diff 采用并发上限（默认 3）。

收益：
- 端到端时延下降，同时避免无上限并发导致的主机资源争抢。

### 4.5 大文件内存保护

实现点：`buildGitPanelFileDiff`
- 对“无可渲染 diff 的新文件”场景，只有在小文件时才读全文生成 synthetic diff。
- 超过 `MAX_SYNTHETIC_DIFF_BYTES`（256KB）时输出摘要占位，不读全文。

收益：
- 防止大文件导致主进程瞬时内存飙升。

### 4.6 提交/推送快速路径

实现点：`commitWorktree` / `pushWorktree`
- `commit/push` 先走 `getChangedFilesForGitOps`（仅文件列表）而非完整 diff 构建。
- `pushWorktree` 采用快速路径：跳过 `pull --rebase`，直接提交后 push。
- 若 push 失败，返回精确错误并按需回滚自动提交。

收益：
- 常规“本地改动 -> push”路径明显缩短。

### 4.7 低成本恢复与容错

实现点：`src/main/ipc/git.ts`
- 锁冲突仅清理“陈旧 lock 文件”且仅重试一次。
- lock 扫描跳过 `.git/objects` 以降低目录遍历成本。
- 非仓库场景快速返回空状态，避免无效命令链。

收益：
- 异常处理成本可控，避免故障放大。

### 4.8 事件上报不阻塞主流程

实现点：`trackGitEventWithSkills`
- telemetry 采用 fire-and-forget 异步上报，不阻塞提交/推送结果返回。

收益：
- 观测能力与用户操作时延解耦。

---

## 5. 按 Git 操作拆解（性能视角）

### 5.1 仓库探测与基础上下文

操作：
- `workspace:isGit`
- `detectIsWorktreePath`
- `getGitRoot`

性能要点：
- 使用短 TTL 缓存避免重复 `rev-parse`。
- worktree 判断与 root 判断并行执行。

### 5.2 状态与摘要

操作：
- `git-status`
- `workspace:getGitPanelSummary`

性能要点：
- `git-status` 单命令解析。
- summary 使用缓存并只计算轻量统计，不构建完整 patch。

### 5.3 分支操作

操作：
- `git:currentBranch`
- `git:listBranches`
- `git:switchBranch`
- `git:createBranch`

性能要点：
- 当前分支读取采用短缓存（GitPanel 流程内复用）。
- 分支列表优先 `--format`，失败再回退文本解析。

### 5.4 Worktree 操作

操作：
- `workspace:listWorktrees`
- `workspace:createWorktree`
- `workspace:removeWorktree`

性能要点：
- `createWorktree` 中 base branch/base commit 并行读取。
- 路径冲突检查和上限检查在本地内存完成，减少无效 Git 调用。

### 5.5 提交（commit）

操作：`workspace:commitWorktree`

性能要点：
- 先走轻量 changed-files 计算。
- 提交后刷新 HEAD 短缓存，后续流程复用。
- commit 统计与分支读取并行。

### 5.6 推送（push）

操作：`workspace:pushWorktree`

性能要点：
- 自动提交阶段走轻量 changed-files 快速路径。
- 跳过 `pull --rebase`，缩短主流程。
- pushability 与 pending commits 由统一快照函数一次产出。
- 自动回滚仅在 HEAD 一致时执行，减少额外风险与操作。

### 5.7 拉取（pull）

操作：`workspace:pullWorktree`

性能要点：
- 分支读取使用缓存。
- 缺失远端分支快速返回，不进入额外失败恢复链。

### 5.8 回退（reject）

操作：
- `workspace:rejectWorktreeChanges`
- `workspace:rejectWorktreeFile`

性能要点：
- 优先使用已有 file history 快照做一步撤销。
- 仅在必要时回退到 Git restore/reset/checkout 路径。

---

## 6. 当前性能优化清单（已落地）

已落地项：
- `git-status` 单命令化解析。
- 工作目录短 TTL 缓存。
- branch/head 短 TTL 缓存。
- Promise 去重缓存（防并发击穿）。
- GitPanel 逐文件 diff 限流并发。
- 单文件 diff 内部并发（patch + numstat）。
- 大文件 synthetic diff 内存保护。
- pushability + pending commits 统一快照并发计算。
- `createWorktree` 基础上下文并行准备。
- commit/push 前 changed-files 轻量快速路径。
- push 流程快速路径（跳过 pull --rebase）。

---

## 7. 建议的性能观测指标

建议至少观测以下指标：
- `git.spawn.count`：单次用户动作触发的 Git 子进程数。
- `git.panel.state.latency_ms`：`workspace:getGitPanelState` 端到端耗时。
- `git.commit.latency_ms` / `git.push.latency_ms`。
- `git.status.latency_ms`：`git-status` 平均与 P95。
- `git.diff.file_count` 与 `git.diff.build.latency_ms` 的相关性。
- `git.cache.hit_ratio`：`gitRoot/branch/head/summary` 命中率。

---

## 8. 后续可继续优化的方向

1. 在 `buildGitPanelState` 中引入“按文件大小/类型自适应并发度”。
2. 为 `getChangedFilesForGitOps` 增加更细粒度缓存（按 thread + worktree + index mtime）。
3. 在 push 快速路径失败后，提供可选“自动重试 pull --rebase”策略开关。
4. 为大仓库提供“分目录增量状态缓存”，减少全仓状态扫描频率。

---

## 9. 维护建议

- 该文档应与以下文件变更同步维护：
  - `src/main/ipc/git.ts`
  - `src/main/ipc/models.ts`
  - `src/renderer/src/components/panels/GitPanelView.tsx`
- 每次新增 Git 功能时，需同时补三类信息：
  - 操作路径（入口 IPC + 核心函数）
  - 性能影响（新增命令数、并发、缓存、内存）
  - 回退策略（失败重试/容错/降级）
