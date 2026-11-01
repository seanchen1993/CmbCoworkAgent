import { useEffect, useRef, useState } from "react"
import type { DevelopmentApi } from "../../../../shared/mods/development"
import type {
  ProjectPromptDraftIdentity,
  ProjectStagePromptsView
} from "../../../../shared/mods/project-stage-prompts"
import { isSameWorkspacePath } from "../../../../shared/workspace-path"

type Buffer = {
  draft: ProjectPromptDraftIdentity
  stageId: string
  body: string
  originalBody: string
}

const button = "rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
const storagePrefix = "creator-stage-prompt:"

function errorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  if (/PROJECT_DRAFT_(REVISION|SOURCE)_CHANGED/.test(code))
    return "草稿已被其他修改更新。你的文字仍保留，请复制需要的内容，放弃本地修改并刷新后再编辑。"
  if (/AUTHORING_SOURCE_LIMIT/.test(code))
    return "阶段提示词或草稿源码超过大小限制，文字仍保留，请精简正文后重试。"
  if (/PROJECT_DRAFT_LIMIT/.test(code))
    return "草稿版本或容量已满，文字仍保留。请返回创造者对话，使用现有续作流程后继续编辑。"
  if (/UNSETTLED|RUNNING|BUSY/.test(code))
    return "当前操作或试用尚未结算。文字仍保留，请核对当前状态后重试。"
  return "无法完成操作，文字仍保留。请核对创造者模式、草稿和工作区后重试。"
}

export function ProjectStagePromptEditor(props: {
  threadId: string
  workspace: string
  accountRevision: number
  api: DevelopmentApi
  onRequestRepair?: (message: string) => void | Promise<void>
  onReturnToChat?: (context: string) => void
}) {
  if (
    !props.api.listProjectPromptDrafts ||
    !props.api.readProjectStagePrompts ||
    !props.api.saveProjectStagePrompt
  )
    return null
  return (
    <ScopedEditor
      key={JSON.stringify([props.accountRevision, props.threadId, props.workspace])}
      {...props}
    />
  )
}

function ScopedEditor({
  threadId,
  workspace,
  accountRevision,
  api,
  onRequestRepair,
  onReturnToChat
}: Parameters<typeof ProjectStagePromptEditor>[0]) {
  const storageKey = `${storagePrefix}${JSON.stringify([accountRevision, threadId, workspace])}`
  const [drafts, setDrafts] = useState<ProjectPromptDraftIdentity[]>([])
  const [view, setView] = useState<ProjectStagePromptsView>()
  const [stageId, setStageId] = useState("")
  const [changeRequest, setChangeRequest] = useState("")
  const [buffer, setBuffer] = useState<Buffer>()
  const [recovery, setRecovery] = useState<Buffer>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [updated, setUpdated] = useState(false)
  const [cached, setCached] = useState(false)
  const live = useRef(false)
  const sequence = useRef(0)
  const pending = useRef(false)
  const bufferRef = useRef(buffer)
  bufferRef.current = buffer
  const stage = view?.stages.find((item) => item.id === stageId)
  const dirty = !!buffer && buffer.body !== buffer.originalBody
  const scope = { threadId, expectedWorkspace: workspace }
  function retire() {
    live.current = false
    sequence.current++
    pending.current = false
  }

  function remember(next: Buffer | undefined) {
    bufferRef.current = next
    setBuffer(next)
    try {
      if (next && next.body !== next.originalBody) {
        const text = JSON.stringify(next)
        let count = 1
        let characters = text.length
        for (let index = 0; index < sessionStorage.length; index++) {
          const key = sessionStorage.key(index)
          if (key?.startsWith(storagePrefix) && key !== storageKey) {
            count++
            characters += sessionStorage.getItem(key)?.length ?? 0
          }
        }
        if (count > 16 || characters > 2 * 1024 * 1024) throw Error("EDITOR_CACHE_LIMIT")
        sessionStorage.setItem(storageKey, text)
      } else sessionStorage.removeItem(storageKey)
      setCached(true)
    } catch {
      setCached(false)
      setError("当前窗口无法暂存文字。请保持编辑页打开，保存草稿或复制正文后再离开。")
    }
  }

  function validateScope(next: { threadId: string; workspace: string }) {
    if (next.threadId !== threadId || !isSameWorkspacePath(next.workspace, workspace))
      throw Error("DEVELOPMENT_SCOPE_CHANGED")
  }

  async function act(work: (current: () => boolean) => Promise<void>) {
    if (pending.current) return
    pending.current = true
    const token = ++sequence.current
    const current = () => live.current && sequence.current === token
    setBusy(true)
    setError("")
    try {
      await work(current)
    } catch (cause) {
      if (current()) setError(errorMessage(cause))
    } finally {
      if (current()) {
        pending.current = false
        setBusy(false)
      }
    }
  }

  function applyView(
    next: ProjectStagePromptsView,
    selected?: string,
    saved?: Buffer,
    preserveRecovery = false
  ) {
    const selectedStage =
      next.stages.find((item) => item.id === (saved?.stageId ?? selected)) ?? next.stages[0]
    setView(next)
    setStageId(selectedStage?.id ?? "")
    if (saved && selectedStage?.id === saved.stageId) {
      remember(saved)
      setRecovery(undefined)
      setMessage("已恢复未保存正文；保存时仍会核对原草稿版本。")
    } else if (selectedStage) {
      const clean = {
        draft: next.draft,
        stageId: selectedStage.id,
        body: selectedStage.body,
        originalBody: selectedStage.body
      }
      if (preserveRecovery) setBuffer(clean)
      else remember(clean)
    } else if (!preserveRecovery) remember(undefined)
  }

  async function refresh(current: () => boolean, restore?: Buffer) {
    const listed = await api.listProjectPromptDrafts!(scope)
    validateScope(listed)
    if (!current()) return
    setDrafts(listed.drafts)
    const selected =
      listed.drafts.find((item) => item.id === (restore?.draft.id ?? view?.draft.id)) ??
      listed.drafts[0]
    if (!selected) {
      setView(undefined)
      setMessage("还没有原生项目草稿。请让创造者从模板创建，或从支持的原生插件派生。")
      return
    }
    const next = await api.readProjectStagePrompts!({ ...scope, id: selected.id })
    validateScope(next)
    if (next.draft.id !== selected.id) throw Error("DEVELOPMENT_SCOPE_CHANGED")
    if (!current()) return
    const matching =
      restore?.draft.id === next.draft.id && next.stages.some((item) => item.id === restore.stageId)
        ? restore
        : undefined
    applyView(next, stageId, matching, !!restore && !matching)
    setUpdated(false)
  }

  useEffect(() => {
    live.current = true
    let saved: Buffer | undefined
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as Buffer | null
      if (
        value &&
        typeof value.body === "string" &&
        typeof value.originalBody === "string" &&
        typeof value.stageId === "string" &&
        typeof value.draft?.id === "string" &&
        typeof value.draft.sourceDigest === "string" &&
        Number.isSafeInteger(value.draft.revision)
      ) {
        saved = value
        setRecovery(value)
      }
    } catch {
      /* Malformed browser recovery data never becomes a write request. */
    }
    void act((current) => refresh(current, saved))
    const unsubscribe = api.onChanged?.((event) => {
      if (live.current && event.threadId === threadId) setUpdated(true)
    })
    const preventLoss = (event: BeforeUnloadEvent) => {
      const current = bufferRef.current
      if (current && current.body !== current.originalBody) {
        event.preventDefault()
        event.returnValue = ""
      }
    }
    window.addEventListener("beforeunload", preventLoss)
    return () => {
      retire()
      unsubscribe?.()
      window.removeEventListener("beforeunload", preventLoss)
    }
    // The parent keys this editor by the full account/thread/workspace scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function discardBeforeSwitch(): boolean {
    if (dirty && !window.confirm("放弃当前未保存的提示词修改并切换？")) return false
    remember(undefined)
    setMessage("")
    return true
  }

  const askCreator = (trial: boolean) => {
    if (!view || !stage || dirty || recovery || !onRequestRepair) return
    const identity = JSON.stringify({
      id: view.draft.id,
      revision: view.draft.revision,
      sourceDigest: view.draft.sourceDigest,
      stageId: stage.id,
      skillPath: stage.skillPath
    })
    void act(async (current) => {
      await onRequestRepair(
        trial
          ? `请读取当前项目草稿并核对最新身份：${identity}。编译、检查最新修订，并沿已有原生确认流程准备从头试用。沿用用户已提供的试用目标；缺少目标时先询问。不得沿用旧版本成功记录，不做中段恢复或自动安装。`
          : `我想修改项目草稿的阶段提示词：${identity}。请先读取实际作者源并核对最新修订，${changeRequest.trim() ? `我的修改要求：${changeRequest.trim()}。先用易懂的中文解释当前阶段职责和拟修改内容，再修改正文` : "先用易懂的中文解释当前阶段职责，再询问我希望怎样修改"}；保留输入输出、检查、配置及其他资源。不要修改生成文件。`
      )
      if (current()) setMessage("请求已发送到原创作对话，无需再次输入。请在那里查看助手的处理进度；此处尚未代表修改或试用完成。")
    })
  }

  return (
    <section aria-label="项目阶段提示词" className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">阶段提示词</h3>
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => {
            if (dirty || recovery) {
              setMessage("未保存文字已保留。请先保存草稿或放弃本地修改，再刷新。")
              return
            }
            void act((current) => refresh(current))
          }}
        >
          刷新草稿
        </button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        在原创作对话说明要怎样调整，助手会读取当前阶段。
        修改后需准备新版本再试用，正在运行的项目不会改变。
      </p>
      {updated && (
        <p role="status" className="text-sm">
          草稿状态有更新。当前文字保持不变，请核对后刷新。
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {recovery && (
        <div className="space-y-2 rounded border p-2">
          <p className="text-sm">有暂存正文尚未匹配当前草稿，请先复制保留或放弃。</p>
          <textarea
            aria-label="待恢复的未保存正文"
            readOnly
            value={recovery.body}
            className="w-full border p-2"
          />
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => {
              setRecovery(undefined)
              remember(undefined)
              void act((current) => refresh(current))
            }}
          >
            放弃暂存正文
          </button>
        </div>
      )}
      {!!drafts.length && (
        <label className="block space-y-1 text-sm">
          项目草稿
          <select
            aria-label="项目草稿"
            className="w-full rounded border bg-background p-2"
            disabled={busy || !!recovery}
            value={view?.draft.id ?? ""}
            onChange={(event) => {
              const id = event.target.value
              if (!discardBeforeSwitch()) return
              void act(async (current) => {
                const next = await api.readProjectStagePrompts!({ ...scope, id })
                validateScope(next)
                if (next.draft.id !== id) throw Error("DEVELOPMENT_SCOPE_CHANGED")
                if (current()) applyView(next)
              })
            }}
          >
            {drafts.map((draft) => (
              <option key={draft.id} value={draft.id}>
                {draft.name} · 修订 {draft.revision}
              </option>
            ))}
          </select>
        </label>
      )}
      {view?.diagnostic && (
        <p role="status" className="text-sm">
          {view.diagnostic}
        </p>
      )}
      {!!view?.stages.length && (
        <label className="block space-y-1 text-sm">
          阶段
          <select
            aria-label="阶段"
            value={stageId}
            disabled={busy || !!recovery}
            className="w-full rounded border bg-background p-2"
            onChange={(event) => {
              const next = view.stages.find((item) => item.id === event.target.value)
              if (!next || !discardBeforeSwitch()) return
              applyView(view, next.id)
            }}
          >
            {view.stages.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {stage && view && (
        <>
          <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
            <p className="font-medium">当前阶段：{stage.title}</p>
            <p>{stage.description || "插件未提供阶段说明，可以回对话请助手先解释这个阶段，再提出修改。"}</p>
            <p>
              本阶段完成后应生成：
              {stage.outputs.map((item) => item.path).join("、") || "插件声明的结果"}。
            </p>
            <p className="text-xs text-muted-foreground">
              原文中的文件路径、字段名和检查要求用于模型执行，不需要你手工填写。项目需求、知识资料和上游结果会另行提供。
            </p>
          </div>
          {onReturnToChat && (
            <button type="button" className={button} disabled={busy || dirty || !!recovery}
              onClick={() => onReturnToChat(
                `请修改项目草稿“${view.draft.name}”的“${stage.title}”阶段。先读取并核对当前作者源：${JSON.stringify({ id: view.draft.id, revision: view.draft.revision, sourceDigest: view.draft.sourceDigest, stageId: stage.id, skillPath: stage.skillPath })}。保留未要求修改的输入输出、检查和资源。我的修改要求：`
              )}>
              回对话修改这个阶段
            </button>
          )}
          {dirty && <p role="status" className="text-sm">有未保存的原文修改，请先展开高级编辑保存或放弃，再回对话。</p>}
          {onRequestRepair && <div className="space-y-2">
            <button type="button" className={button} disabled={busy || dirty || !!recovery}
              onClick={() => askCreator(true)}>
              让助手准备试用
            </button>
            <p className="text-xs text-muted-foreground">读取这个草稿的最新版本并检查；准备好后在试用区确认，不会直接执行或安装。</p>
          </div>}
          <details className="space-y-3 rounded-lg border p-3">
            <summary className="cursor-pointer text-sm text-muted-foreground">高级：查看或直接编辑阶段原文</summary>
          {onRequestRepair && (
            <label className="block space-y-1 text-sm">
              修改要求（用日常语言描述即可）
              <textarea
                aria-label="阶段提示词修改要求"
                className="min-h-20 w-full rounded border bg-background p-3"
                value={changeRequest}
                disabled={busy || !!recovery}
                placeholder="例如：先列出待确认的问题，再给出方案，减少重复说明。"
                onChange={(event) => setChangeRequest(event.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                填写后点击“让创造者修改”；此处不会直接替换原文。
              </span>
            </label>
          )}
          <dl className="space-y-1 break-words text-xs text-muted-foreground">
            <div>
              <dt className="inline font-medium">输入：</dt>
              <dd className="inline">{stage.inputs.join("；") || "无阶段产物输入"}</dd>
            </div>
            <div>
              <dt className="inline font-medium">输出：</dt>
              <dd className="inline">
                {stage.outputs.map((item) => `${item.id} (${item.path})`).join("；") || "无"}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">检查：</dt>
              <dd className="inline">{stage.checks.join("；") || "未声明检查"}</dd>
            </div>
            <div>
              <dt className="inline font-medium">作者源：</dt>
              <dd className="inline">{stage.skillPath}</dd>
            </div>
          </dl>
          {stage.diagnostic && (
            <p role="status" className="text-sm">
              {stage.diagnostic}
            </p>
          )}
          <label className="block space-y-1 text-sm">
            阶段提示词正文（当前实际指令，可直接编辑）
            <textarea
              aria-label="阶段提示词正文"
              className="min-h-56 w-full rounded border bg-background p-3 font-mono text-sm"
              readOnly={!stage.editable || busy || !!recovery}
              value={buffer?.body ?? stage.body}
              onChange={(event) =>
                remember({
                  draft: buffer?.draft ?? view.draft,
                  stageId,
                  originalBody: buffer?.originalBody ?? stage.body,
                  body: event.target.value
                })
              }
            />
          </label>
          {dirty && (
            <p className="text-xs text-muted-foreground">
              {cached
                ? "有未保存修改，已暂存在当前窗口；尚未写入插件草稿。"
                : "有未保存修改，仅保留在当前编辑页内存；离开前请保存或复制正文。"}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              disabled={busy || !dirty || !stage.editable || !!recovery}
              onClick={() => {
                if (!buffer) return
                const submitted = buffer
                void act(async (current) => {
                  const next = await api.saveProjectStagePrompt!({
                    ...scope,
                    id: submitted.draft.id,
                    revision: submitted.draft.revision,
                    sourceDigest: submitted.draft.sourceDigest,
                    stageId: submitted.stageId,
                    body: submitted.body
                  })
                  validateScope(next)
                  if (next.draft.id !== submitted.draft.id) throw Error("DEVELOPMENT_SCOPE_CHANGED")
                  if (!current()) return
                  applyView(next, submitted.stageId)
                  setDrafts((items) =>
                    items.map((item) => (item.id === next.draft.id ? next.draft : item))
                  )
                  setMessage("草稿已保存为新修订。请重新编译并从头试用；旧版试用记录仍保留。")
                  setUpdated(false)
                })
              }}
            >
              保存草稿
            </button>
            <button
              type="button"
              className={button}
              disabled={busy || !dirty}
              onClick={() => {
                if (!window.confirm("放弃未保存的提示词修改？")) return
                remember(undefined)
                setMessage("")
                void act((current) => refresh(current))
              }}
            >
              放弃本地修改
            </button>
            {onRequestRepair && (
              <>
                <button
                  type="button"
                  className={button}
                  disabled={busy || dirty || !!recovery}
                  onClick={() => askCreator(false)}
                >
                  让创造者修改
                </button>
              </>
            )}
          </div>
          </details>
        </>
      )}
    </section>
  )
}
