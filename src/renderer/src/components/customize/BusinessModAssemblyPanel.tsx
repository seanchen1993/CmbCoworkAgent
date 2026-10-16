import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useConfigurationDraft } from "@/lib/configuration-target"
import { useAppStore } from "@/lib/store"
import { openDerivedProject } from "@/lib/derived-project-intent"
import { useFeatureGate } from "@/lib/feature-gates"
import { FEATURE_GATES } from "../../../../shared/feature-gates"
import type { BusinessModSource } from "../../../../shared/business-mod-assembly-api"
import type {
  BusinessModAssemblyRequest,
  BusinessModCopy,
  BusinessModInspection,
  BusinessModPreview
} from "../../../../shared/business-mods"

export function BusinessModAssemblyPanel(props: {
  threadId: string | null
  workspace?: string | null
  active: boolean
  initialPluginId?: string
}) {
  if (!props.threadId || !props.workspace)
    return (
      <p className="rounded-lg border p-4 text-sm">先打开聊天并选择项目文件夹，再组合业务 Mods。</p>
    )
  return (
    <ScopedAssembly
      key={JSON.stringify([props.threadId, props.workspace])}
      threadId={props.threadId}
      workspace={props.workspace}
      active={props.active}
      initialPluginId={props.initialPluginId}
    />
  )
}

function ScopedAssembly({
  threadId,
  workspace,
  active,
  initialPluginId
}: {
  threadId: string
  workspace: string
  active: boolean
  initialPluginId?: string
}) {
  const scope = { threadId, expectedWorkspace: workspace }
  const api = window.api.businessModAssembly
  const projectMode = useFeatureGate(FEATURE_GATES.projectMode)
  const [available, setAvailable] = useState<BusinessModSource[]>([])
  const [sourceId, setSourceId] = useState(initialPluginId ?? "")
  const [sources, setSources] = useState<BusinessModInspection[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [name, setName] = useState("my-autobiz")
  const [version, setVersion] = useState("1.0.0")
  const [preview, setPreview] = useState<BusinessModPreview | null>(null)
  const [copies, setCopies] = useState<BusinessModCopy[]>([])
  const [copy, setCopy] = useState<BusinessModCopy | null>(null)
  const [enabled, setEnabled] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const live = useRef(true)
  const lock = useRef(false)
  const visible = useRef(active)
  visible.current = active
  const createRequest = useRef(crypto.randomUUID())
  const previewRequest = useRef<BusinessModAssemblyRequest | null>(null)
  useEffect(() => {
    if (initialPluginId) setSourceId(initialPluginId)
  }, [initialPluginId])
  useConfigurationDraft({ threadId, workspace }, selected.length > 0 && !copy, busy)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  useEffect(() => {
    if (!active || !api) return
    let current = true
    void Promise.all([api.sources(scope), api.list(scope)])
      .then(([items, saved]) => {
        if (current) {
          setAvailable(items)
          setCopies(saved)
        }
      })
      .catch((cause) => {
        if (current) setError(String(cause))
      })
    return () => {
      current = false
    }
    // The parent remounts this component when the owner scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, threadId, workspace])
  const run = async (operation: () => Promise<void>) => {
    if (lock.current || !visible.current || !api) return
    lock.current = true
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await operation()
    } catch (cause) {
      if (live.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      lock.current = false
      if (live.current) setBusy(false)
    }
  }
  const changed = () => {
    setPreview(null)
    setCopy(null)
    setNotice("")
    createRequest.current = crypto.randomUUID()
  }
  const remember = (result: BusinessModCopy) => {
    if (!live.current) return
    setCopy(result)
    setCopies((previous) => [result, ...previous.filter((item) => item.copyId !== result.copyId)])
  }
  const inspect = (pluginId?: string) =>
    run(async () => {
      const result = await api.inspect({ ...scope, ...(pluginId ? { pluginId } : {}) })
      if (!result || !live.current) return
      if (sources.some((item) => item.sourceDigest === result.sourceDigest)) {
        setNotice("这个 Mods 来源已添加。")
        return
      }
      changed()
      setSources((previous) => [...previous, result])
    })
  const key = (source: BusinessModInspection, modId: string) => `${source.id}:${modId}`
  const selectedMods = selected.flatMap((value) =>
    sources.flatMap((source) =>
      source.mods
        .filter((mod) => key(source, mod.id) === value)
        .map((mod) => ({ ...mod, source, key: value }))
    )
  )
  const businessSteps = selectedMods.filter((mod) => mod.kind !== "function")
  const extensions = selectedMods.filter((mod) => mod.kind === "function")
  const copyInput = copy && { ...scope, copyId: copy.copyId, expectedDigest: copy.digest }
  if (!api) return <p role="status">请重启更新后的应用，加载 Mods 组装功能。</p>
  return (
    <section aria-label="业务 Mods 组装" className="space-y-4">
      <div>
        <h2 className="font-semibold">从业务 Mods 组装新插件</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          添加 AutoBiz 或自己的 Mods 来源，挑选业务步骤和界面扩展，生成带独立名称、技能和检查的新插件。
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          这里制作可安装、可分享的插件。安装后再创建项目，项目中的每次需求使用插件提供的流程；聊天搭配只配置聊天功能和工具。
        </p>
      </div>
      {error && (
        <p role="alert" className="break-words rounded border border-destructive p-3 text-sm">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="break-all rounded bg-muted p-3 text-sm">
          {notice}
        </p>
      )}
      <fieldset disabled={busy} className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">1. 添加 Mods 来源</legend>
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="已安装的 Mods 来源"
            className="min-w-0 max-w-full rounded border bg-background p-2 text-sm"
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
          >
            <option value="">选择已安装插件</option>
            {available.map((item) => (
              <option key={item.pluginId} value={item.pluginId}>
                {item.name}
              </option>
            ))}
          </select>
          <Button variant="outline" disabled={!sourceId} onClick={() => void inspect(sourceId)}>
            读取插件 Mods
          </Button>
          <Button variant="outline" onClick={() => void inspect()}>
            导入 Mods 源码目录
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          自己的 Mod 也使用“导入 Mods 源码目录”，可与 AutoBiz 一起组合。
        </p>
        {sources.map((source) => (
          <div key={source.id} className="space-y-2 rounded border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 break-all text-sm font-medium">{source.sourceName}</p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  changed()
                  setSources((items) => items.filter((item) => item.id !== source.id))
                  setSelected((items) =>
                    items.filter((item) => !source.mods.some((mod) => key(source, mod.id) === item))
                  )
                }}
              >
                移除来源
              </Button>
            </div>
            {source.mods.map((mod) => (
              <label key={mod.id} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  aria-label={`选择 Mod ${mod.title}`}
                  checked={selected.includes(key(source, mod.id))}
                  onChange={(event) => {
                    changed()
                    setSelected((items) =>
                      event.target.checked
                        ? [...items, key(source, mod.id)]
                        : items.filter((item) => item !== key(source, mod.id))
                    )
                  }}
                />
                <span>
                  {mod.title} <span className="text-xs text-muted-foreground">{mod.id}</span>
                  {mod.kind === "function" && (
                    <span className="ml-2 rounded bg-muted px-1 text-xs">常驻扩展</span>
                  )}
                  {mod.dependsOn.length > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      必需依赖：{mod.dependsOn.join("、")}
                    </span>
                  )}
                </span>
              </label>
            ))}
            {source.warnings.map((warning, index) => (
              <p key={index} className="text-xs">
                {warning}
              </p>
            ))}
          </div>
        ))}
      </fieldset>
      <fieldset disabled={busy} className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">2. 设置插件和步骤顺序</legend>
        <label className="block text-sm">
          新插件名称
          <input
            aria-label="新插件名称"
            value={name}
            className="mt-1 block w-full rounded border bg-background p-2"
            onChange={(event) => {
              changed()
              setName(event.target.value)
            }}
          />
        </label>
        <label className="block text-sm">
          插件版本
          <input
            aria-label="插件版本"
            value={version}
            className="mt-1 block w-full rounded border bg-background p-2"
            onChange={(event) => {
              changed()
              setVersion(event.target.value)
            }}
          />
        </label>
        {businessSteps.length === 0 && (
          <p className="text-sm text-muted-foreground">请先勾选需要的业务 Mods。</p>
        )}
        <ol aria-label="已选业务步骤" className="space-y-2">
          {businessSteps.map((mod, index) => (
            <li key={mod.key} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="flex-1">
                {index + 1}. {mod.title}
              </span>
              {([-1, 1] as const).map((delta) => (
                <Button
                  key={delta}
                  size="sm"
                  variant="outline"
                  disabled={index + delta < 0 || index + delta >= businessSteps.length}
                  aria-label={`${mod.title}${delta < 0 ? "上移" : "下移"}`}
                  onClick={() => {
                    changed()
                    setSelected((items) => {
                      const next = [...items]
                      const from = next.indexOf(mod.key)
                      const to = next.indexOf(businessSteps[index + delta].key)
                      ;[next[from], next[to]] = [next[to], next[from]]
                      return next
                    })
                  }}
                >
                  {delta < 0 ? "上移" : "下移"}
                </Button>
              ))}
            </li>
          ))}
        </ol>
        {extensions.length > 0 && (
          <div aria-label="已选常驻扩展" className="space-y-2 rounded bg-muted/40 p-3 text-sm">
            <p className="font-medium">随插件加入的常驻扩展</p>
            <ul className="space-y-1">
              {extensions.map((mod) => (
                <li key={mod.key}>{mod.title}</li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              面板等扩展不占用流程步骤，安装后按灵件权限与使用设置启用。
            </p>
          </div>
        )}
        <Button
          disabled={!businessSteps.length || !name.trim() || !version.trim()}
          onClick={() =>
            void run(async () => {
              const request: BusinessModAssemblyRequest = {
                  name: name.trim(),
                  version: version.trim(),
                  order: businessSteps.map((mod) => mod.id),
                  sources: sources.map((source) => ({
                    inspectionId: source.id,
                    modIds: source.mods
                      .filter((mod) => selected.includes(key(source, mod.id)))
                      .map((mod) => mod.id)
                  }))
              }
              previewRequest.current = request
              const result = await api.preview({ ...scope, request })
              if (live.current) setPreview(result)
            })
          }
        >
          预览新插件
        </Button>
      </fieldset>
      {preview && (
        <div aria-label="组装预览" className="space-y-3 rounded-lg border p-4">
          <h3 className="font-medium">
            3. 核对并生成：{preview.name} · {preview.version}
          </h3>
          <ol className="list-inside list-decimal space-y-1 text-sm">
            {preview.steps.map((step) => (
              <li key={step.id}>
                {step.title}
                {step.added ? "（自动补齐依赖）" : ""} · {step.sourceName}
              </li>
            ))}
          </ol>
          {!!preview.extensions?.length && (
            <div aria-label="常驻扩展预览" className="space-y-1 rounded bg-muted/40 p-3 text-sm">
              <p className="font-medium">常驻扩展（不作为流程步骤）</p>
              {preview.extensions.map((extension) => (
                <p key={extension.id}>
                  {extension.title} · {extension.sourceName}
                </p>
              ))}
            </div>
          )}
          <p className="text-sm">
            生成 {preview.files.length} 个文件，包含所选业务实现和公共运行内核。
          </p>
          <details className="rounded border p-3 text-xs">
            <summary className="cursor-pointer">查看包含的技能与文件</summary>
            <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
              {preview.files.map((file) => (
                <li key={file.path} className="break-all">
                  {file.path}
                </li>
              ))}
            </ul>
          </details>
          {preview.diagnostics.map((message, index) => (
            <p key={index} className="text-sm">
              {message}
            </p>
          ))}
          {preview.requiresFixedWorkflowAcknowledgement && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                disabled={busy}
                checked={previewRequest.current?.acceptFixedWorkflow === true}
                onChange={(event) => {
                  const previous = previewRequest.current
                  if (!previous) return
                  const request = { ...previous, acceptFixedWorkflow: event.target.checked }
                  void run(async () => {
                    const result = await api.preview({ ...scope, request })
                    if (live.current) {
                      previewRequest.current = request
                      setPreview(result)
                    }
                  })
                }}
              />
              我选择使用当前所选的固定步骤，并知悉来源的动态启用、跳过与人工选择行为未被保留。
            </label>
          )}
          <Button
            disabled={busy || !preview.valid || !!copy}
            onClick={() =>
              void run(async () => {
                remember(
                  await api.create({
                    ...scope,
                    previewId: preview.previewId,
                    requestId: createRequest.current
                  })
                )
              })
            }
          >
            生成独立插件
          </Button>
        </div>
      )}
      {copy && copyInput && (
        <div aria-label="新插件交付" className="space-y-3 rounded-lg border p-4">
          <h3 className="font-medium">
            {copy.name} · {copy.version}
          </h3>
          <p className="text-sm">
            {copy.fileCount} 个文件 ·{" "}
            {{ created: "已生成，待检查", checked: "包检查通过", installed: "已安装" }[copy.status]}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  remember(await api.check(copyInput))
                })
              }
            >
              检查插件包
            </Button>
            <Button
              disabled={busy || copy.status !== "checked"}
              onClick={() =>
                void run(async () => {
                  const result = await api.install(copyInput)
                  remember(result)
                  if (live.current) useAppStore.getState().bumpPluginVersion()
                })
              }
            >
              安装新插件
            </Button>
            <Button
              variant="outline"
              disabled={busy || copy.status === "created"}
              onClick={() =>
                void run(async () => {
                  const result = await api.export(copyInput)
                  if (result && live.current)
                    setNotice(`已导出 ${result.files} 个文件：${result.output}`)
                })
              }
            >
              导出 ZIP
            </Button>
            {copy.pluginId && (
              <Button
                variant="outline"
                disabled={busy || enabled === copy.pluginId}
                onClick={() =>
                  void run(async () => {
                    const result = await window.api.plugins.setEnabled(copy.pluginId!, true)
                    if (result?.success === false) throw Error(result.error || "启用失败")
                    if (live.current) {
                      setEnabled(copy.pluginId!)
                      useAppStore.getState().bumpPluginVersion()
                    }
                  })
                }
              >
                {enabled === copy.pluginId ? "新插件已启用" : "启用新插件"}
              </Button>
            )}
            {copy.pluginId && (
              <Button
                disabled={busy || enabled !== copy.pluginId || !projectMode.enabled}
                onClick={() => openDerivedProject(copy.pluginId!, copy.name, scope)}
              >
                新建项目
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            包检查验证组成与文件完整性；业务产物由新项目运行时逐步检查。
          </p>
        </div>
      )}
      {copies.length > 0 && (
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer text-sm">已生成的插件（{copies.length}）</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {copies.map((item) => (
              <Button
                key={item.copyId}
                variant="outline"
                disabled={busy}
                onClick={() => setCopy(item)}
              >
                {item.name} · {item.version}
              </Button>
            ))}
          </div>
        </details>
      )}
      {busy && (
        <p role="status" className="text-sm">
          正在处理，请稍候…
        </p>
      )}
    </section>
  )
}
