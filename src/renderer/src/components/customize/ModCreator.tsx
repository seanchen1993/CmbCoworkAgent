import {
  readReuseSelection,
  rememberReuseSelection,
  subscribeReuseSelection
} from "./development-reuse-receipts"
import { ModsDevelopmentPanel } from "./ModsDevelopmentPanel"
import { DevelopmentReusePanel, type DevelopmentReuseOrigin } from "./DevelopmentReusePanel"
import { AuthoringInstallPanel } from "./AuthoringInstallPanel"
import { AuthoringPreviewPanel } from "./AuthoringPreviewPanel"
import { useEffect, useRef, useState } from "react"
import { normalizeWorkspacePathKey } from "../../../../shared/workspace-path"
import { useConfigurationDraft } from "@/lib/configuration-target"
import type {
  AuthoringDocument,
  AuthoringFile,
  AuthoringSummary,
  AuthoringTemplateKind
} from "../../../../shared/mods/authoring"

const templates: [AuthoringTemplateKind, string][] = [
  ["command", "命令"],
  ["tool", "工具"],
  ["rule", "规则"],
  ["panel", "面板"],
  ["flow-action", "流程动作"]
]
const inputClass = "devclaw-input w-full min-w-0 text-sm"
const buttonClass = "rounded border px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  if (message.includes("AUTHORING_VERSION_LIMIT"))
    return "此草稿已达到16个版本上限。可清理旧源码历史后继续保存，当前编辑已保留。"
  if (message.includes("AUTHORING_DRAFT_LIMIT"))
    return "此项目已达到16份草稿上限。请打开不再需要的草稿并明确删除，当前编辑尚未保存。"
  if (message.includes("AUTHORING_STORAGE_LIMIT"))
    return "此项目草稿库已达到容量上限。可清理旧历史或删除不再需要的草稿，当前编辑已保留。"
  if (message.includes("AUTHORING_VERSION_CHANGED"))
    return "版本已被其他操作更新。保留了当前编辑，请重新打开草稿后核对。"
  if (message.includes("AUTHORING_SCOPE_CHANGED"))
    return "项目范围已变化。保留了当前编辑，请关闭草稿库后重新打开。"
  if (/AUTHORING_(SOURCE|PLUGIN_MANIFEST|TEMPLATE|INPUT)/.test(message))
    return "源码或模板输入不符合要求，请核对路径、内容和容量。"
  return "草稿操作未完成。当前编辑已保留，请稍后重试。"
}

interface CreatorProps {
  threadId: string | null
  workspaceHint?: string | null
  onReturnToChat?: () => void
  onOpenReuseThread?: (threadId: string) => Promise<void>
  developmentAllowed?: boolean
  section?: "create" | "advanced"
  onOpenAdvanced?: () => void
}
export function ModCreator(props: CreatorProps): React.JSX.Element {
  return <Creator key={JSON.stringify([props.threadId, props.workspaceHint])} {...props} />
}
function Creator({
  threadId,
  workspaceHint,
  onReturnToChat,
  onOpenReuseThread,
  developmentAllowed = true,
  section,
  onOpenAdvanced
}: CreatorProps): React.JSX.Element {
  const selectionScope = JSON.stringify([threadId, workspaceHint])
  const [reuse, updateReuse] = useState(() => readReuseSelection(selectionScope))
  const setReuse = (
    value: { document: AuthoringDocument; origin: DevelopmentReuseOrigin } | null
  ) => {
    rememberReuseSelection(selectionScope, value)
    updateReuse(value)
  }
  useEffect(
    () =>
      subscribeReuseSelection(selectionScope, () => {
        updateReuse(readReuseSelection(selectionScope))
      }),
    [selectionScope]
  )
  const [opened, setOpened] = useState(false)
  const [workspace, setWorkspace] = useState("")
  const [library, setLibrary] = useState<AuthoringSummary[]>([])
  const [document, setDocument] = useState<AuthoringDocument | null>(null)
  const [editing, setEditing] = useState(false)
  const [files, setFiles] = useState<AuthoringFile[]>([])
  const [selectedPath, setSelectedPath] = useState("")
  const [id, setId] = useState("")
  const [name, setName] = useState("")
  const [instruction, setInstruction] = useState("")
  const [kind, setKind] = useState<AuthoringTemplateKind>("command")
  const [comparison, setComparison] = useState<AuthoringDocument | null>(null)
  const [busy, setBusy] = useState(false)
  useConfigurationDraft({ threadId, workspace: workspace || workspaceHint || null },
    document ? name !== document.name || JSON.stringify(files) !== JSON.stringify(document.source.files)
      : !!(id.trim() || name.trim() || instruction.trim() || files.length), busy)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const alive = useRef(true),
    generation = useRef(0),
    pending = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const operate = async <T,>(request: () => Promise<T>, accept: (value: T) => void) => {
    if (pending.current) return
    pending.current = true
    const sequence = ++generation.current
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const value = await request()
      if (alive.current && generation.current === sequence) accept(value)
    } catch (error) {
      if (alive.current && generation.current === sequence) setError(publicError(error))
    } finally {
      if (alive.current && generation.current === sequence) {
        pending.current = false
        setBusy(false)
      }
    }
  }
  const scope = () => ({ threadId: threadId!, expectedWorkspace: workspace })
  const assertWorkspace = (actual: string) => {
    if (
      !actual ||
      (workspaceHint !== undefined &&
        normalizeWorkspacePathKey(actual) !== normalizeWorkspacePathKey(workspaceHint)) ||
      (workspace && normalizeWorkspacePathKey(actual) !== normalizeWorkspacePathKey(workspace))
    )
      throw Error("AUTHORING_SCOPE_CHANGED")
  }
  const accept = (value: AuthoringDocument) => {
    assertWorkspace(value.workspace)
    setDocument(value)
    setId(value.id)
    setName(value.name)
    setFiles(value.source.files)
    setSelectedPath(value.source.files[0]?.path ?? "")
    setComparison(null)
    setEditing(true)
    setLibrary((items) => [
      ...items.filter((item) => item.id !== value.id),
      {
        id: value.id,
        name: value.name,
        currentRevision: value.currentRevision,
        updatedAt: value.updatedAt
      }
    ])
  }
  const cancel = () => {
    // Cancel discards renderer state only. It never changes the installed composition.
    generation.current++
    pending.current = false
    setBusy(false)
    setEditing(false)
    setDocument(null)
    setFiles([])
    setComparison(null)
    setError("")
    setNotice("")
  }
  const selected = files.find((file) => file.path === selectedPath)
  const changedPaths = comparison
    ? [
        ...new Set([
          ...comparison.source.files.map((file) => file.path),
          ...files.map((file) => file.path)
        ])
      ].filter(
        (path) =>
          comparison.source.files.find((file) => file.path === path)?.text !==
          files.find((file) => file.path === path)?.text
      )
    : []
  return (
    <div className="space-y-4">
      <div hidden={section === "advanced"} inert={section === "advanced"} className="space-y-4">
        <ModsDevelopmentPanel
          threadId={developmentAllowed ? threadId : null}
          workspaceHint={workspaceHint}
          onReturnToChat={onReturnToChat}
          promotionBlocked={editing || busy}
          onPromoted={(value) => {
            assertWorkspace(value.workspace)
            setReuse(null)
            setWorkspace(value.workspace)
            setOpened(true)
            accept(value)
            onOpenAdvanced?.()
          }}
          onReuse={
            onOpenReuseThread
              ? (value, origin) => {
                  assertWorkspace(value.workspace)
                  setReuse({ document: value, origin })
                }
              : undefined
          }
        />
        {reuse && threadId && onOpenReuseThread && (
          <>
            <DevelopmentReusePanel
              threadId={threadId}
              document={reuse.document}
              origin={reuse.origin}
              onOpenThread={onOpenReuseThread}
              onReturnToChat={onReturnToChat}
            />
            <button className={buttonClass} onClick={() => setReuse(null)}>
              关闭复用步骤（保留已发生的操作）
            </button>
          </>
        )}
      </div>
      <section
        hidden={section === "create"}
        inert={section === "create"}
        aria-label="组件源码草稿库"
        className="space-y-3 rounded-xl border bg-card p-4"
      >
        <h2 className="font-semibold">编辑草稿与版本</h2>
        <p className="text-sm text-muted-foreground">
          从模板生成并编辑源码。保存和还原只记录草稿版本，不安装、不授权、不应用到当前组合。保存后可使用独立样例预览；预览不会改变当前组合。
        </p>
        <p className="text-xs text-muted-foreground">
          独立样例预览使用隔离环境，不能证明文件、网络或模型已实际调用。需要真实效果时回到制作聊天申请试用，核对用途、目标和权限后直接验证；保存使用再走安装与版本授权。
        </p>
        {!opened ? (
          <button
            className={buttonClass}
            disabled={!threadId || busy}
            onClick={() =>
              void operate(
                () => window.api.mods.authoring.list(threadId!),
                (value) => {
                  assertWorkspace(value.workspace)
                  setWorkspace(value.workspace)
                  setLibrary(value.drafts)
                  setOpened(true)
                }
              )
            }
          >
            打开草稿库
          </button>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <button
                className={buttonClass}
                disabled={busy || editing}
                onClick={() => {
                  cancel()
                  setId("")
                  setName("")
                  setInstruction("")
                  setKind("command")
                  setEditing(true)
                }}
              >
                新建草稿
              </button>
              <button
                className={buttonClass}
                disabled={busy}
                onClick={() => {
                  cancel()
                  setOpened(false)
                  setWorkspace("")
                }}
              >
                关闭草稿库
              </button>
            </div>
            <ul className="space-y-1">
              {library.map((item) => (
                <li key={item.id}>
                  <button
                    className={buttonClass}
                    disabled={busy || editing}
                    onClick={() =>
                      void operate(
                        () => window.api.mods.authoring.read({ ...scope(), id: item.id }),
                        accept
                      )
                    }
                  >
                    {item.name} · v{item.currentRevision}
                  </button>
                </li>
              ))}
            </ul>
            {!library.length && !editing && <p className="text-sm">此项目还没有源码草稿。</p>}
            {editing && (
              <div className="space-y-3 border-t pt-3">
                <label className="block text-sm">
                  标识（小写英文、数字、连字符）
                  <input
                    className={inputClass}
                    aria-label="草稿标识"
                    value={id}
                    maxLength={48}
                    disabled={busy || !!document || files.length > 0}
                    onChange={(event) => setId(event.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  名称
                  <input
                    className={inputClass}
                    aria-label="草稿名称"
                    value={name}
                    maxLength={100}
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                {!files.length && (
                  <>
                    <label className="block text-sm">
                      模板
                      <select
                        aria-label="组件模板"
                        className="devclaw-select w-full min-w-0 text-sm"
                        value={kind}
                        disabled={busy}
                        onChange={(event) => setKind(event.target.value as AuthoringTemplateKind)}
                      >
                        {templates.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-sm">
                      用途说明
                      <textarea
                        aria-label="用途说明"
                        className={inputClass}
                        value={instruction}
                        maxLength={2000}
                        disabled={busy}
                        onChange={(event) => setInstruction(event.target.value)}
                      />
                    </label>
                    <button
                      className={buttonClass}
                      disabled={busy || !id || !name.trim() || !instruction.trim()}
                      onClick={() =>
                        void operate(
                          () =>
                            window.api.mods.authoring.generate({
                              ...scope(),
                              id,
                              name,
                              instruction,
                              kind
                            }),
                          (source) => {
                            setFiles(source.files)
                            setSelectedPath(source.files[0]?.path ?? "")
                            setNotice("模板已生成，尚未保存或安装。")
                          }
                        )
                      }
                    >
                      生成模板源码
                    </button>
                  </>
                )}
                {files.length > 0 && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      最多32个文件，单文件64 KiB、合计256 KiB；内容按原文保存。
                    </p>
                    <label className="block text-sm">
                      文件
                      <select
                        aria-label="源码文件"
                        className={inputClass}
                        value={selectedPath}
                        onChange={(event) => setSelectedPath(event.target.value)}
                      >
                        {files.map((file) => (
                          <option key={file.path}>{file.path}</option>
                        ))}
                      </select>
                    </label>
                    <textarea
                      aria-label="文件源码"
                      spellCheck={false}
                      className={`${inputClass} min-h-64 font-mono`}
                      value={selected?.text ?? ""}
                      disabled={busy}
                      onChange={(event) =>
                        setFiles((items) =>
                          items.map((file) =>
                            file.path === selectedPath
                              ? { ...file, text: event.target.value }
                              : file
                          )
                        )
                      }
                    />
                    <button
                      className={buttonClass}
                      disabled={busy || !name.trim()}
                      onClick={() =>
                        void operate(
                          () =>
                            window.api.mods.authoring.save({
                              ...scope(),
                              id,
                              name,
                              files,
                              expectedRevision: document?.currentRevision ?? 0
                            }),
                          (value) => {
                            accept(value)
                            setNotice(`已保存源码 v${value.currentRevision}，未安装、未应用。`)
                          }
                        )
                      }
                    >
                      保存源码版本
                    </button>
                  </>
                )}
                {document && threadId && (
                  <AuthoringPreviewPanel
                    threadId={threadId}
                    workspace={workspace}
                    document={document}
                    dirty={
                      name !== document.name ||
                      JSON.stringify(files) !== JSON.stringify(document.source.files)
                    }
                  />
                )}
                {document && threadId && (
                  <AuthoringInstallPanel
                    threadId={threadId}
                    workspace={workspace}
                    document={document}
                    dirty={
                      name !== document.name ||
                      JSON.stringify(files) !== JSON.stringify(document.source.files)
                    }
                    api={window.api.mods.authoringInstall}
                  />
                )}
                {document && (
                  <div className="space-y-2">
                    <details className="rounded border p-3">
                      <summary className="cursor-pointer text-sm">管理源码历史与草稿容量</summary>
                      <p className="my-2 text-sm text-muted-foreground">
                        此草稿保留了 {document.versions.length}/16 个源码版本，本项目有{" "}
                        {library.length}/16 份草稿。
                        清理旧历史保留当前与上一个版本；删除草稿会移除这份草稿的全部已保存源码。
                        两项操作均不卸载已正式安装的灵件，不撤销已发生的业务效果。
                        当前未保存编辑保留，正在核验被移除旧草稿的操作可能需要重新准备。
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          className={buttonClass}
                          disabled={busy || document.versions.length <= 2}
                          onClick={() => {
                            if (
                              !window.confirm(
                                `清理“${document.name}”的旧源码历史？保留最近两个版本，永久移除其余历史，不能再从草稿库还原它们。当前未保存编辑会保留。`
                              )
                            )
                              return
                            void operate(
                              () =>
                                window.api.mods.authoring.prune({
                                  ...scope(),
                                  id,
                                  expectedRevision: document.currentRevision,
                                  expectedSourceDigest: document.source.digest,
                                  acknowledgeHistoryLoss: true
                                }),
                              (value) => {
                                setDocument(value)
                                setComparison(null)
                                setNotice(
                                  "旧源码历史已清理，保留最近两个版本和当前未保存编辑；可以继续保存。"
                                )
                              }
                            )
                          }}
                        >
                          清理旧源码历史
                        </button>
                        <button
                          className={buttonClass}
                          disabled={busy}
                          onClick={() => {
                            if (
                              !window.confirm(
                                `永久删除“${document.name}”的全部已保存草稿源码？正式安装版本不卸载，当前未保存编辑保留为未保存草稿。`
                              )
                            )
                              return
                            void operate(
                              () =>
                                window.api.mods.authoring.remove({
                                  ...scope(),
                                  id,
                                  expectedRevision: document.currentRevision,
                                  expectedSourceDigest: document.source.digest,
                                  acknowledgeHistoryLoss: true
                                }),
                              () => {
                                setDocument(null)
                                setComparison(null)
                                setLibrary((items) => items.filter((item) => item.id !== id))
                                setNotice(
                                  "已删除已保存草稿并释放位置；编辑区内容尚未保存，正式安装版本保留。"
                                )
                              }
                            )
                          }}
                        >
                          删除已保存草稿
                        </button>
                      </div>
                    </details>
                    <label className="block text-sm">
                      比较历史版本
                      <select
                        aria-label="比较历史版本"
                        className={inputClass}
                        disabled={busy}
                        value={comparison?.revision ?? ""}
                        onChange={(event) => {
                          const revision = Number(event.target.value)
                          if (!revision) {
                            setComparison(null)
                            return
                          }
                          void operate(
                            () => window.api.mods.authoring.read({ ...scope(), id, revision }),
                            setComparison
                          )
                        }}
                      >
                        <option value="">选择版本与当前编辑比较</option>
                        {document.versions.map((version) => (
                          <option key={version.revision} value={version.revision}>
                            v{version.revision}
                            {version.restoredFrom ? `（还原自 v${version.restoredFrom}）` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    {comparison && (
                      <div aria-label="源码版本差异" className="space-y-2">
                        <p className="text-sm">
                          v{comparison.revision} → 当前编辑：{changedPaths.length}{" "}
                          个文件变化。左侧为历史源码，右侧为当前编辑。
                        </p>
                        {changedPaths.map((path) => (
                          <details key={path}>
                            <summary className="break-all text-sm">{path}</summary>
                            <div className="grid min-w-0 gap-2 md:grid-cols-2">
                              <pre
                                aria-label={`${path} 历史源码`}
                                className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border p-2 text-xs"
                              >
                                {comparison.source.files.find((file) => file.path === path)?.text ??
                                  "（不存在）"}
                              </pre>
                              <pre
                                aria-label={`${path} 当前源码`}
                                className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border p-2 text-xs"
                              >
                                {files.find((file) => file.path === path)?.text ?? "（不存在）"}
                              </pre>
                            </div>
                          </details>
                        ))}
                        <p className="text-xs text-muted-foreground">
                          还原会追加新版本并替换当前未保存编辑；已有版本保留，当前组合不变。
                        </p>
                        <button
                          className={buttonClass}
                          disabled={busy}
                          onClick={() =>
                            void operate(
                              () =>
                                window.api.mods.authoring.restore({
                                  ...scope(),
                                  id,
                                  expectedRevision: document.currentRevision,
                                  sourceRevision: comparison.revision
                                }),
                              (value) => {
                                accept(value)
                                setNotice(
                                  `已还原为新版本 v${value.currentRevision}，未安装、未应用。`
                                )
                              }
                            )
                          }
                        >
                          将 v{comparison.revision} 还原为新版本
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <button className={buttonClass} disabled={busy} onClick={cancel}>
                  取消编辑
                </button>
              </div>
            )}
          </>
        )}
        {busy && (
          <p role="status" className="text-sm">
            正在处理草稿…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
      </section>
    </div>
  )
}
