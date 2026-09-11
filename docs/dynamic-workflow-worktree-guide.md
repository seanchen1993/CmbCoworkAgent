# Dynamic Workflow Worktree 使用与测试指南

本文面向需要试用或验收 Dynamic Workflow Worktree 的同事。它说明什么时候该用、如何发起、如何合并或丢弃交付物，以及可直接执行的验收用例。

## 一句话说明

在 workflow 脚本的某个子代理调用中指定 `isolation: "worktree"` 后，CmbCowork 会为该子代理创建一份独立的 Git worktree 和临时分支。子代理的仓库编辑发生在这份独立副本中；原工作区在用户点击 **合并** 前不会接收该交付物。

这适合多个子代理需要并行修改代码、且可能碰到同一工作区时使用。只读分析、顺序修改或明确依赖前一个子代理结果的任务，不需要使用 worktree。

## 使用前条件

1. 当前工作区必须位于 Git 仓库中，且源工作区当前处于一个本地分支上，不能是 detached HEAD。
2. 要分配给隔离子代理的工作区范围必须干净：先提交、暂存或丢弃该范围内的 staged、unstaged 和 untracked 改动。
3. 若工作区是 monorepo 子目录，例如 `packages/a`，创建 worktree 时只检查该子目录；但点击 **合并** 前，整个源 checkout 都必须干净。
4. 需要合并的交付物必须已经提交，且 worktree 不得有未提交改动。

工作流第一次创建 isolated agent 时，会冻结当时的源分支和基线提交。同一个并行批次的 worktree 都从这份基线创建，彼此看不到对方的改动。

## 如何发起

在界面中切换到 **Dynamic Workflow** 模式，然后明确要求工作流使用 worktree。例如可直接复制下面这段需求：

```text
请创建并执行一个 Dynamic Workflow：把“实现功能 A”和“实现功能 B”拆给两个独立子代理并行完成。

两个实现子代理都必须使用 agent(..., { isolation: "worktree" })；分别只修改各自负责的文件；完成后运行相关测试，并执行 git add 和 git commit。不要 push。最后告诉我每个 worktree 的完成情况，供我在 Workflow 面板查看和合并。
```

如果同事直接编写 workflow 脚本，可使用下面这个最小示例。它让一个 isolated agent 创建并提交一个测试文件：

```js
export const meta = {
  name: "worktree-smoke-test",
  description: "验证 isolated worktree 的创建、提交和 UI 合并",
  phases: [{ title: "隔离修改", detail: "在独立 worktree 中创建测试文件" }]
}

phase("隔离修改")

const result = await agent(
  `在当前仓库中完成以下操作：
1. 新建文件 worktree-smoke-proof.md，内容为 "created by isolated workflow agent"。
2. 执行 git status 确认只有这个测试文件是本次改动。
3. 执行 git add worktree-smoke-proof.md。
4. 执行 git commit -m "test: add worktree smoke proof"。
5. 最终只简要说明提交是否成功。`,
  {
    label: "worktree-smoke",
    phase: "隔离修改",
    isolation: "worktree"
  }
)

log(`isolated agent result: ${result ?? "null"}`)
```

注意：只有精确的 `isolation: "worktree"` 才会启用隔离。不要使用 `"workspace"`、`"remote"` 等其他值；它们是旧的未实现值，当前只会给出 workflow 日志警告并按共享工作区执行，不能提供隔离保证。

## 子代理编写约定

给 isolated agent 的提示应包含下面几条：

- 明确它负责的文件或目录，多个并行 agent 不要修改重叠文件。
- 完成后运行必要的测试。
- 对准备交付给 Cmb 合并的改动，执行 `git add` 和 `git commit -m "..."`，并保持 worktree 干净。
- 不要 `git push` 临时分支。
- 不要依赖其他并行 agent 的未合并改动；它们互相不可见。

`agent()` 的返回类型不会因为 worktree 改变：无 schema 时仍是最终文本；有 schema 时仍是已校验对象。worktree 路径、分支和状态由 Cmb 持久化并显示在 Workflow 面板中，不会附加到脚本返回值。

推荐的并行示例：

```js
export const meta = {
  name: "parallel-isolated-changes",
  description: "两个互不重叠的实现任务并行修改",
  phases: [{ title: "并行实现", detail: "每个 agent 使用独立 worktree" }]
}

phase("并行实现")

const results = await parallel([
  () => agent(
    "只修改 src/feature-a/**。实现需求 A，运行相关测试，git add、git commit；不要 push。",
    { label: "feature-a", phase: "并行实现", isolation: "worktree" }
  ),
  () => agent(
    "只修改 src/feature-b/**。实现需求 B，运行相关测试，git add、git commit；不要 push。",
    { label: "feature-b", phase: "并行实现", isolation: "worktree" }
  )
])

log(`completed: ${results.filter(Boolean).length}/2`)
```

## Workflow 面板中的处理方式

每个产生改动的 isolated agent 都会在运行面板的 **Worktree 交付物** 区域留下记录。面板会显示临时分支、worktree 根目录、状态和必要的错误信息。

| 状态 | 含义 | 建议操作 |
|---|---|---|
| `待处理` | 子代理成功结束，worktree 有可处理改动 | 先查看 Diff；已提交且无未提交改动时可合并，否则先提交或丢弃 |
| `需恢复` | 子代理失败、取消或 worktree 异常，但改动被保留 | 查看错误和 Diff；确认后丢弃，或在 worktree 中修复、提交后再处理 |
| `已合并` | 交付物已安全合入源分支 | 通常无需操作；若提示清理待重试，点击重试清理 |
| `已丢弃` | 用户已选择放弃该交付物 | 通常无需操作；若提示清理待重试，点击重试清理 |

面板操作含义：

- **Diff**：只查看该 worktree 相对其基线的改动，不会修改源工作区。
- **合并**：先做源工作区干净度、分支、范围和冲突预检；通过后才合入源分支，并清理 worktree。
- **丢弃**：放弃该 worktree 的所有改动并删除其 worktree/临时分支。操作会要求二次确认。
- **重试清理**：仅用于已合并或已丢弃、但因异常未能删除残留 worktree 的记录。

**合并不是自动发生的。** 这意味着多 agent 并行时，每个有改动的交付物都需要在面板中分别检查并决定合并或丢弃。这样可以避免多个独立改动未经审查就写入源分支。

## 自动保留与自动删除规则

| 子代理结果 | Worktree 结果 |
|---|---|
| 成功且没有任何改动 | 自动删除，不会留下交付物 |
| 成功且有改动 | 保留在面板中，等待用户合并或丢弃 |
| 失败/超时/取消且没有改动 | 自动删除 |
| 失败/超时/取消但已有改动 | 保留为“需恢复”，避免丢失改动 |
| 无法安全创建 worktree | `agent()` 返回 `null`，不会回退到源工作区执行 |

因此，当一个 isolation 调用返回 `null` 时，应把它当作“本次隔离任务没有执行”，而不是当作“已经在共享工作区完成”。

## 合并失败时怎么办

合并会拒绝以下常见状态：

- 源工作区有未提交改动；先处理源工作区改动。
- 源分支已切换，或正在进行其他 Git 操作；回到原分支并完成当前 Git 操作。
- worktree 有未提交改动；复制面板中的 worktree 根目录，在本地终端进入该目录后检查、提交或决定丢弃。
- 预检发现冲突；源工作区不会被修改。先决定是手动处理冲突，还是丢弃该交付物。

若仓库要求 commit hook、签名或其他强制提交策略，请在本地按仓库的正常流程人工审查和集成。Cmb 的受管合并不会执行仓库 hooks 或 commit signing。

## 可执行验收用例

请在测试仓库或可安全修改的分支上执行。每个用例结束后，先在 Git 面板或终端确认源工作区状态，再开始下一个用例。

### 用例 1：已提交交付物可审查、可合并

1. 确保源工作区干净。
2. 运行上面的 `worktree-smoke-test` 脚本，或用同等自然语言需求生成 workflow。
3. 预期：源工作区在点击合并前没有 `worktree-smoke-proof.md`；Workflow 面板显示一条 `待处理` 交付物，且没有“未提交”标记。
4. 点击 **Diff**，确认只包含测试文件。
5. 点击 **合并**。
6. 预期：源分支出现该提交和文件；面板提示已安全合并并清理 worktree；`git worktree list` 不再显示该临时 worktree。

### 用例 2：未提交改动不能被误合并

1. 让 isolated agent 新建一个唯一测试文件，但明确要求“不提交”。
2. 预期：面板中该记录为 `待处理` 且标记“未提交”；**合并**按钮不可用。
3. 点击 **丢弃** 并确认。
4. 预期：源工作区没有该文件，临时 worktree 被清理。

### 用例 3：无改动任务自动清理

1. 运行一个只读取、分析、且明确“不修改文件”的 isolated agent。
2. 预期：任务成功返回，但不会留下 Worktree 交付物；`git worktree list` 中不会残留 Cmb 创建的临时 worktree。

### 用例 4：创建失败不回退到源工作区

1. 在源工作区的分配范围内故意创建一个未跟踪文件，保持未提交。
2. 发起要求 isolated agent 创建另一个唯一文件的 workflow。
3. 预期：该 isolated call 返回 `null` 或显示“需要干净 assigned workspace”的创建错误；源工作区中绝不能出现 agent 原本要创建的那个唯一文件。
4. 删除或提交人为创建的脏文件，恢复源工作区。

### 用例 5：并行 worktree 互不覆盖

1. 源工作区保持干净。
2. 发起两个 `parallel()` isolated agents，让它们分别创建并提交两个不同文件，例如 `worktree-a.md` 和 `worktree-b.md`。
3. 预期：面板出现两条独立交付物；在未点击合并前，源工作区不出现两个文件。
4. 分别查看 Diff 后逐条合并。
5. 预期：两个提交都进入源分支，且每条交付物均被独立清理。

## 边界与注意事项

- Worktree 是仓库编辑隔离，不是用于执行不受信任代码的主机安全沙箱。不要把它当作网络或任意系统文件访问的安全边界。
- Worktree 会有额外创建时间和磁盘开销；只在并行写入确实可能冲突时使用。
- isolated agent 不会在恢复运行时从 journal 回放：恢复会为该调用重新创建 fresh worktree，旧的已保留交付物仍可在面板中处理。
- 不要手工删除 Cmb 管理的 worktree 目录；若面板明确提示需要手工清理，则按提示删除显示的 **worktree 根目录**，再点击“重试清理”。
- 临时 worktree 的物理目录由应用管理，默认位于 `~/.cmbcoworkagent/worktrees/` 下。日常使用只需通过面板操作，不需要直接进入该目录。

## 测试反馈应包含什么

反馈问题时请附上：

1. workflow 的 `runId`；
2. 使用的仓库、源分支和是否为 monorepo 子目录；
3. 面板显示的 worktree 状态、错误文本和 Diff 摘要；
4. 点击操作前后 `git status --short` 与 `git worktree list --porcelain` 的结果；
5. 是否执行过 Merge、Discard 或 Cleanup，以及期望与实际结果。
