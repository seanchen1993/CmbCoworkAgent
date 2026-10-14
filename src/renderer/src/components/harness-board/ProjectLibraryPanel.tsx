import { useEffect, useRef, useState } from "react"
import type {
  LocalProjectView,
  LocalProjectSummary
} from "../../../../shared/project-runtime/platform-api"
import type { ProjectLibraryEntry } from "../../../../shared/project-runtime/project-library"

const statusText = {
  saved: "已保存到本机",
  sending: "正在发送",
  partial: "尚未全部发送",
  sent: "接收方已确认",
  unknown: "发送结果需要核对"
}
function explain(error: unknown) {
  const code = error instanceof Error ? error.message : String(error)
  if (/EVIDENCE_STALE|CHECK_REQUIRED/.test(code))
    return "成果有变化或尚未检查通过。请先回到当前阶段检查，再保存。"
  if (/DESTINATION_CHANGED/.test(code))
    return "这份交付已绑定原接收地址。更换接收方请重新准备一份交付。"
  if (/DESTINATION_INVALID|FILE_PATH_INVALID/.test(code))
    return "请填写 HTTPS 接收地址和相对目录（例如 my-project/DEV/Features/feature-1）。地址不要包含密码或查询参数。"
  if (/PREVIEW_LOCAL_ONLY/.test(code))
    return "试用项目只支持本地保存。安装插件并创建正式本地任务后才可以发送。"
  if (/BUSY/.test(code)) return "当前还有操作在执行，请等它结束后再试。"
  if (/LIMIT/.test(code))
    return "超过保存限额：每项目最多 50 份，每份总计 16 MB、单文件 5 MB。请减少产物或移除不需要的记录。"
  return "操作没有完成，请检查项目模板是否仍可用后重试。"
}

export function ProjectLibraryPanel({ view }: { view: LocalProjectView }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="text-sm underline"
        onClick={() => setOpen(!open)}
      >
        {open ? "收起成果与经验" : "打开成果与经验"}
      </button>
      {open && <ProjectLibraryContents key={view.project.projectId} view={view} />}
    </div>
  )
}

function ProjectLibraryContents({ view }: { view: LocalProjectView }) {
  const api = window.api.harnessBoard.localProjects.library
  const [entries, setEntries] = useState<ProjectLibraryEntry[]>([])
  const [projects, setProjects] = useState<LocalProjectSummary[]>([])
  const [operationId, setOperationId] = useState("")
  const [title, setTitle] = useState("")
  const [note, setNote] = useState("")
  const [selected, setSelected] = useState<ProjectLibraryEntry>()
  const [text, setText] = useState("")
  const [endpoint, setEndpoint] = useState("")
  const [remotePath, setRemotePath] = useState("")
  const [target, setTarget] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const active = useRef(true)
  const lock = useRef(false)
  const pid = view.project.projectId
  const checked = view.operations.filter((item) =>
    ["succeeded", "transitioned"].includes(item.status)
  )
  const running = view.operations.some((item) =>
    ["started", "cancel_requested"].includes(item.status)
  )
  async function act(work: () => Promise<void>) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await work()
    } catch (cause) {
      if (active.current) setError(explain(cause))
    } finally {
      lock.current = false
      if (active.current) setBusy(false)
    }
  }
  async function refresh() {
    const rows = await api.list(pid)
    if (active.current) setEntries(rows)
  }
  useEffect(() => {
    active.current = true
    void act(refresh)
    return () => {
      active.current = false
    }
  }, [pid]) // eslint-disable-line react-hooks/exhaustive-deps -- Mounted with project id as key.
  async function capture(kind: "knowledge" | "delivery") {
    const result = await api.capture(pid, {
      operationId: operationId || checked[0]?.operationId,
      kind,
      title,
      note
    })
    if (!active.current) return
    setEntries((previous) => [result, ...previous])
    setTitle("")
    setNote("")
    setNotice(
      kind === "knowledge" ? "经验已保存到本机。" : "交付已准备好，请打开记录核对文件与接收方。"
    )
  }
  const fieldClass = "w-full rounded border bg-background px-2 py-1.5 text-sm"
  return (
    <section aria-label="成果与经验" className="space-y-3 rounded-lg border p-3">
      <h3 className="text-sm font-medium">成果与经验</h3>
      <p className="text-xs text-muted-foreground">
        保存检查通过的文件副本。经验可以给其他本地任务参考；交付需要你确认后才发送，不会改变阶段进度。
      </p>
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
      <fieldset disabled={busy || running} className="space-y-2">
        <label className="block text-xs">
          保存哪次成果
          <select
            aria-label="保存哪次成果"
            className={fieldClass}
            value={operationId || checked[0]?.operationId || ""}
            onChange={(event) => setOperationId(event.target.value)}
          >
            {!checked.length && <option value="">完成一次阶段检查后可以保存</option>}
            {checked.map((item) => (
              <option key={item.operationId} value={item.operationId}>
                {view.project.manifest.stages.find((stage) => stage.id === item.stageId)?.title} ·{" "}
                {new Date(item.updatedAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <input
          aria-label="成果名称"
          placeholder="名称，例如：订单数据校验经验"
          className={fieldClass}
          maxLength={100}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          aria-label="经验说明"
          placeholder="可选：记录结论、适用场景和注意事项"
          className={fieldClass}
          maxLength={4000}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="flex flex-wrap gap-3 text-sm">
          <button
            className="underline disabled:opacity-50"
            disabled={!checked.length || !title.trim()}
            onClick={() => void act(() => capture("knowledge"))}
          >
            保存为经验
          </button>
          <button
            className="underline disabled:opacity-50"
            disabled={!checked.length || !title.trim()}
            onClick={() => void act(() => capture("delivery"))}
          >
            准备交付
          </button>
        </div>
      </fieldset>
      <p className="text-xs text-muted-foreground">
        开始后续阶段时，助手只读取本项目最近 3 份经验摘要（最多 8,000
        字符）。这只是参考，仍需重新检查本次成果。
      </p>
      {!entries.length && !busy && (
        <p className="text-xs text-muted-foreground">还没有保存的成果。</p>
      )}
      <ul className="space-y-2">
        {entries.map((entry) => (
          <li key={entry.id} className="rounded border p-2 text-sm">
            <button
              disabled={busy}
              className="text-left underline"
              onClick={() =>
                void act(async () => {
                  const rows =
                    entry.kind === "knowledge"
                      ? await window.api.harnessBoard.localProjects.list()
                      : []
                  if (!active.current) return
                  setSelected(entry)
                  setProjects(rows)
                  setTarget("")
                  setText("")
                  setConfirmed(false)
                  setEndpoint(entry.endpoint ?? "")
                  setRemotePath(entry.remotePath ?? "")
                })
              }
            >
              {entry.title}
            </button>
            <p className="text-xs text-muted-foreground">
              {entry.kind === "knowledge" ? "经验" : "交付"} · {entry.files.length} 个文件 ·{" "}
              {statusText[entry.status]}
              {entry.source ? " · 从其他任务复用" : ""}
            </p>
          </li>
        ))}
      </ul>
      {selected && (
        <div className="space-y-3 rounded border p-3" aria-label="成果详情">
          <div className="flex justify-between gap-2">
            <h4 className="font-medium">{selected.title}</h4>
            <button disabled={busy} onClick={() => setSelected(undefined)}>
              关闭
            </button>
          </div>
          <p className="whitespace-pre-wrap text-sm">{selected.note}</p>
          <p className="text-xs">
            {statusText[selected.status]} · 保存的是当时副本，原文件修改不会改写它。
          </p>
          <ul className="space-y-1 text-xs">
            {selected.files.map((file) => (
              <li key={file.path}>
                <button
                  disabled={busy}
                  className="break-all underline"
                  onClick={() =>
                    void act(async () => {
                      setText("")
                      const result = await api.read(pid, selected.id, file.path)
                      if (active.current)
                        setText(result.text + (result.truncated ? "\n（仅显示前 32 KB）" : ""))
                    })
                  }
                >
                  {file.path}
                </button>{" "}
                · {file.size} 字节
                {selected.kind === "delivery" &&
                  ` · ${{ pending: "待发送", uploaded: "接收方已确认", failed: "被接收方拒绝", unknown: "需要核对" }[file.status]}`}
              </li>
            ))}
          </ul>
          {selected.kind === "delivery" && (
            <p className="text-xs">
              目录清单 ·{" "}
              {selected.catalogStatus
                ? { uploaded: "接收方已确认", failed: "被接收方拒绝", unknown: "需要核对" }[
                    selected.catalogStatus
                  ]
                : "待发送"}
            </p>
          )}
          {text && (
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
              {text}
            </pre>
          )}
          {selected.kind === "knowledge" ? (
            <fieldset disabled={busy} className="space-y-2">
              <label className="block text-xs">
                复用到另一个任务
                <select
                  aria-label="复用到另一个任务"
                  className={fieldClass}
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  <option value="">选择任务</option>
                  {projects
                    .filter((item) => item.projectId !== pid && item.status === "active")
                    .map((item) => (
                      <option key={item.projectId} value={item.projectId}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </label>
              <div className="flex gap-3 text-sm">
                <button
                  disabled={!target}
                  className="underline disabled:opacity-50"
                  onClick={() =>
                    void act(async () => {
                      await api.reuse(pid, selected.id, target)
                      if (active.current) {
                        setNotice(
                          `已加入“${projects.find((item) => item.projectId === target)?.name ?? "所选任务"}”的经验。`
                        )
                        setSelected(undefined)
                        setTarget("")
                      }
                    })
                  }
                >
                  加入所选任务的经验
                </button>
                <button
                  className="underline"
                  onClick={() =>
                    void act(async () => {
                      const more = await window.api.harnessBoard.localProjects.list(
                        projects.at(-1)?.projectId
                      )
                      if (active.current)
                        setProjects((old) => [
                          ...old,
                          ...more.filter(
                            (item) => !old.some((value) => value.projectId === item.projectId)
                          )
                        ])
                    })
                  }
                >
                  加载更多任务
                </button>
              </div>
            </fieldset>
          ) : (
            <fieldset disabled={busy || selected.status === "sent"} className="space-y-2">
              <p className="text-xs text-muted-foreground">
                接收服务须支持 TestAgent 风格的文件上传（path +
                file）。地址和目录由团队提供；企业登录鉴权继续使用原插件入口。
              </p>
              <input
                aria-label="接收服务地址"
                className={fieldClass}
                placeholder="https://你的服务/file/upload"
                value={endpoint}
                readOnly={!!selected.endpoint}
                onChange={(event) => {
                  setEndpoint(event.target.value)
                  setConfirmed(false)
                }}
              />
              <input
                aria-label="接收目录"
                className={fieldClass}
                placeholder="my-project/DEV/Features/feature-1"
                value={remotePath}
                readOnly={!!selected.remotePath}
                onChange={(event) => {
                  setRemotePath(event.target.value)
                  setConfirmed(false)
                }}
              />
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我已核对以上文件、地址和目录，同意发送。结果不确定时，我已先核对接收方，接受重试可能覆盖同名文件。
              </label>
              <button
                className="text-sm underline disabled:opacity-50"
                disabled={!confirmed || !endpoint || !remotePath || !!view.preview}
                onClick={() =>
                  void act(async () => {
                    setConfirmed(false)
                    const next = await api.send(pid, selected.id, { endpoint, remotePath })
                    if (!active.current) return
                    setSelected(next)
                    setConfirmed(false)
                    await refresh()
                  })
                }
              >
                确认发送{selected.status !== "saved" ? "未确认部分" : ""}
              </button>
              {!!view.preview && (
                <p className="text-xs">试用项目不能向外发送；请先安装模板并新建本地任务。</p>
              )}
            </fieldset>
          )}
          {selected.error && (
            <p role="status" className="text-xs text-destructive">
              {selected.error}
            </p>
          )}
          <details>
            <summary className="cursor-pointer text-xs">移除这份本地记录</summary>
            <p className="my-2 text-xs">
              会删除本机副本，不会删除工作区文件、其他任务复用的副本或已经上传的文件。
            </p>
            <button
              disabled={busy}
              className="text-xs text-destructive underline"
              onClick={() =>
                void act(async () => {
                  await api.remove(pid, selected.id)
                  if (!active.current) return
                  setSelected(undefined)
                  await refresh()
                })
              }
            >
              确认移除
            </button>
          </details>
        </div>
      )}
      {busy && (
        <p role="status" className="text-xs">
          正在处理成果，请稍候…
        </p>
      )}
    </section>
  )
}
