import type { JsonObject, Register } from "devclaw-mods"

type Change = { path: string; oldPath?: string; status: string }
type Page = {
  baseCommit: string
  head: string
  branch: string | null
  comparisonId: string
  readAt: string
  entries: Change[]
  nextCursor?: string
  total: number
  truncated: boolean
  completeness: "complete" | "partial"
  excluded: { denied: number; gitlinks: number }
  limitations: string[]
}
type Preview = {
  path: string
  patch: string
  content?: string | null
  binary: boolean
  truncated: boolean
  limitations: string[]
}
type Worktree = {
  id: string
  directory: string
  directoryTruncated?: boolean
  baseCommit: string
  branch: string
  status: string
}
type Run = { runId: string; worktrees: Worktree[]; nextWorktreeOffset?: number | null }
const git = { provider: "native.git", id: "inspection", version: "1.0.0" }
const workflow = { provider: "native.workflow", id: "runs", version: "1.0.0" }
const target = { kind: "current" as const }
const shortLabel = (value: string, limit = 18) => {
  const characters = Array.from(value)
  return characters.length > limit ? `…${characters.slice(-limit).join("")}` : value
}
const labels: Record<string, string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
  "type-changed": "类型变化",
  conflict: "冲突",
  untracked: "未跟踪"
}

export const register: Register<"worktree-changes"> = (on) => {
  let directory = "",
    baseCommit = "",
    directoryRef = "",
    root = ""
  let page: Page | null = null,
    preview: Preview | null = null
  let worktrees: Worktree[] = [],
    runId = "",
    nextWorktreeOffset: number | null = null
  let notice = "选择目录和起点，再加载变更。"
  let error = "",
    busy = false,
    requestSequence = 0,
    viewSequence = 0,
    callSequence = 0
  const clearContent = () => {
    page = null
    preview = null
  }

  on.capability(
    {
      apiVersion: "devclaw.capability/v1",
      id: "changes",
      version: "1.0.0",
      title: "代码变更",
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: [
        {
          id: "open",
          title: "打开代码变更",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          requiredPermissions: ["ui.open"],
          cancellable: true,
          idempotency: "keyed"
        },
        {
          id: "close",
          title: "关闭代码变更",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          requiredPermissions: [],
          cancellable: true,
          idempotency: "keyed"
        }
      ],
      presentation: {
        type: "surface",
        apiVersion: "devclaw.surface/v2",
        interaction: "query",
        id: "changes",
        title: "代码变更",
        placement: "sidebar",
        paneId: "changes",
        openAction: "open",
        closeAction: "close"
      }
    },
    {
      async act($, event) {
        ++viewSequence
        ++requestSequence
        clearContent()
        error = ""
        busy = false
        if (event.action === "open") await $.ui.open({ id: "changes", title: "代码变更" })
        return { opened: event.action === "open" }
      }
    }
  )

  on("ui.render", { component: "Pane", requestId: "changes" }, ($, event) => {
    const { Box, Text, Input, Button, Select, Code } = $.ui.resolve(event)
    const redraw = () => $.ui.invalidate("ui.render")
    const invoke = async (ref: typeof git, action: string, input: JsonObject) => {
      const answer = await $.platform.act({
        ref,
        target,
        action,
        input,
        requestKey: `changes:${viewSequence}:${++callSequence}`
      })
      if (answer.status !== "succeeded") throw Error(answer.error || `读取未完成：${answer.status}`)
      return answer.value
    }
    const run = async (read: (current: () => boolean) => Promise<void>) => {
      const sequence = ++requestSequence,
        view = viewSequence
      const current = () => sequence === requestSequence && view === viewSequence
      busy = true
      error = ""
      preview = null
      let cancelled = false
      redraw()
      try {
        await read(current)
      } catch (failure) {
        const code = failure instanceof Error ? failure.message : String(failure)
        cancelled = code === "MODS_CANCELLED" || code === "MODS_QUERY_SUPERSEDED"
        if (current()) {
          if (cancelled) {
            // Native cancellation can arrive before the replacement callback enters the guest.
            // Keep its file list available, but never keep a cancelled preview or publish again.
            notice = "读取已取消，可重新选择文件。"
          } else {
            clearContent()
            error = code.slice(0, 300)
            notice = "读取失败，旧正文已清空。请确认目录授权和起点后重新加载。"
            if (/DIRECTORY|DENIED|REVOK|CLOSED/.test(error)) {
              directoryRef = ""
              root = ""
            }
          }
        }
      } finally {
        if (current()) {
          busy = false
          if (!cancelled) redraw()
        }
      }
    }
    const updateDirectory = async (value: string, baseline?: string) => {
      ++requestSequence
      clearContent()
      busy = false
      error = ""
      const previous = directoryRef
      directoryRef = ""
      root = ""
      directory = value
      if (baseline !== undefined) baseCommit = baseline
      notice = "目录已选择。点击加载变更，由宿主核验读取权限。"
      redraw()
      if (previous) {
        try {
          await invoke(git, "release", { directoryRef: previous })
        } catch {
          /* A revoked or closed old reference is already unusable. */
        }
      }
    }
    const load = async (cursor?: string) => {
      const previous = page
      clearContent()
      await run(async (current) => {
        if (!directory.trim() || !baseCommit.trim()) throw Error("请输入目录及明确的起点提交")
        const catalog = await $.platform.list()
        if (
          !catalog.capabilities.some(
            (item) =>
              item.available &&
              item.ref.provider === git.provider &&
              item.ref.id === git.id &&
              item.ref.version === git.version
          )
        )
          throw Error("当前客户端缺少只读代码检查能力，请使用支持该协议的构建")
        if (!current()) return
        if (!directoryRef) {
          const bound = (await invoke(git, "bind", { directory })) as {
            directoryRef: string
            root: string
          }
          if (!current()) return
          directoryRef = bound.directoryRef
          root = bound.root
        }
        const result = (await invoke(git, "list", {
          directoryRef,
          baseCommit,
          limit: 30,
          ...(cursor ? { cursor, comparisonId: previous?.comparisonId } : {})
        })) as Page
        if (!current()) return
        page = result
        // Freeze symbolic input to the exact resolved commit for every later refresh.
        baseCommit = result.baseCommit
        notice =
          result.total === 0
            ? result.completeness === "partial"
              ? "可读取范围内没有代码变更。"
              : "没有代码变更。"
            : `共 ${result.total} 项 · 本页 ${result.entries.length} 项`
      })
    }
    const discover = async (offset?: number) =>
      run(async (current) => {
        const state = await $.platform.read({ ref: workflow, target })
        const observed = state.value as { run?: Run | null } | undefined
        const id = offset !== undefined ? runId : observed?.run?.runId
        if (!id) {
          if (current()) {
            worktrees = []
            notice = "当前会话没有可读取的工作流。可手动填写目录。"
          }
          return
        }
        const result = (await invoke(workflow, "inspect", {
          runId: id,
          worktreeOffset: offset ?? 0,
          limit: 16
        })) as { run: Run | null }
        if (!current()) return
        runId = id
        worktrees = result.run?.worktrees ?? []
        nextWorktreeOffset = result.run?.nextWorktreeOffset ?? null
        notice = worktrees.length
          ? "选择工作树，再点击加载变更。"
          : "本页没有工作树，可手动填写目录。"
      })
    const selectFile = async (path: string) => {
      const comparison = page
      if (!comparison) return
      await run(async (current) => {
        const result = (await invoke(git, "file", {
          directoryRef,
          baseCommit: comparison.baseCommit,
          comparisonId: comparison.comparisonId,
          path
        })) as Preview
        if (current()) {
          preview = result
          notice = `已读取 ${path}`
        }
      })
    }
    const children = [
      Text({ children: "起点提交 → 当前工作目录", dimColor: true, wrap: "wrap" }),
      Input({
        key: "directory",
        label: "目录",
        value: directory,
        placeholder: "输入本机目录",
        submitLabel: "选择目录",
        onSubmit: (value: string) => updateDirectory(value)
      }),
      Input({
        key: "baseline",
        label: "起点提交",
        value: baseCommit,
        placeholder: "插件提供的起点 SHA 或明确提交引用",
        submitLabel: "设置起点",
        onSubmit: (value: string) => {
          ++requestSequence
          baseCommit = value
          clearContent()
          error = ""
          busy = false
          notice = "起点已更新，点击加载变更。"
          redraw()
        }
      }),
      Box({
        flexDirection: "row",
        gap: 1,
        children: [
          Button({ key: "load", label: "加载 / 刷新变更", onPress: () => load() }),
          Button({ key: "discover", label: "读取工作流工作树", onPress: () => discover() })
        ]
      }),
      Text({ children: busy ? "正在读取当前选择…" : notice, wrap: "wrap" }),
      ...(error ? [Text({ children: `读取失败：${error}`, wrap: "wrap" })] : []),
      ...(worktrees.length
        ? [
            Select({
              key: "worktree",
              label: "工作流工作树",
              options: [
                { value: "", label: "选择目录" },
                ...worktrees.map((tree) => ({
                  value: tree.id,
                  label: `${tree.branch || tree.id} · ${tree.status} · ${tree.directory}`.slice(
                    0,
                    950
                  )
                }))
              ],
              value: worktrees.find((tree) => tree.directory === directory)?.id ?? "",
              onSelect: async (id: string) => {
                const tree = worktrees.find((item) => item.id === id)
                if (!tree) return
                if (tree.directoryTruncated) {
                  clearContent()
                  error = "目录显示已截断，请填写完整本机路径"
                  redraw()
                  return
                }
                await updateDirectory(tree.directory, tree.baseCommit)
              }
            })
          ]
        : []),
      ...(nextWorktreeOffset !== null
        ? [
            Button({
              key: "worktrees-next",
              label: "下一页工作树",
              onPress: () => discover(nextWorktreeOffset ?? undefined)
            })
          ]
        : []),
      ...(page
        ? [
            ...(page.completeness === "partial"
              ? [
                  Text({
                    children: `仅展示可读取范围：${page.excluded.denied} 项受权限保护，${page.excluded.gitlinks} 个子模块未检查。`,
                    wrap: "wrap"
                  })
                ]
              : []),
            ...page.entries.map((entry, index) =>
              Button({
                key: `file-${index}`,
                label: `${labels[entry.status] ?? entry.status} · ${shortLabel(entry.path)}`,
                onPress: () => selectFile(entry.path)
              })
            ),
            ...(page.nextCursor
              ? [
                  Button({
                    key: "next",
                    label: "下一页变更",
                    onPress: () => load(page?.nextCursor)
                  })
                ]
              : [])
          ]
        : []),
      ...(preview
        ? [
            Text({ children: `文件：${preview.path}`, bold: true, wrap: "wrap" }),
            ...(preview.binary ? [Text({ children: "二进制文件不显示文本。" })] : []),
            ...(preview.truncated ? [Text({ children: "内容达到预览上限，结果不完整。" })] : []),
            ...(preview.limitations.includes("conflict-current-content-only")
              ? [Text({ children: "文件存在冲突，仅显示当前内容。" })]
              : []),
            ...(preview.limitations.includes("working-tree-conversion-not-applied")
              ? [Text({ children: "预览使用文件原始文本，未执行仓库自定义转换。", wrap: "wrap" })]
              : []),
            ...(preview.patch
              ? [Code({ source: preview.patch, format: "diff", path: preview.path, wrap: "wrap" })]
              : preview.content
                ? [
                    Code({
                      source: preview.content,
                      format: "source",
                      path: preview.path,
                      wrap: "wrap"
                    })
                  ]
                : [])
          ]
        : []),
      ...(page
        ? [
            Text({ children: `目录：${root}`, dimColor: true, wrap: "wrap" }),
            Text({
              children: `起点 ${page.baseCommit.slice(0, 8)} → HEAD ${page.head.slice(0, 8)}\n${shortLabel(page.branch ?? "detached")} · ${page.readAt.slice(11, 19)} UTC`,
              dimColor: true,
              wrap: "wrap"
            }),
            Text({ children: "目录变化后请刷新。", dimColor: true, wrap: "wrap" })
          ]
        : [])
    ]
    return Box({
      flexDirection: "row",
      width: "100%",
      gap: 1,
      children: children.map((child) => Box({ width: "100%", children: [child] }))
    })
  })
}
