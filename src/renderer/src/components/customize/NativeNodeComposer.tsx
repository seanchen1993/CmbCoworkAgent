import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { openNativeNodePlan } from "@/lib/node-composition-intent"
import { openDerivedProject, openExistingPluginProject } from "@/lib/derived-project-intent"
import { captureConfigurationScope } from "@/lib/configuration-target"
import { useAppStore } from "@/lib/store"
import { openPluginSettings } from "@/lib/plugin-settings-intent"
import { installedProjectPluginIdentity, nativeProjectBindings, type InstalledProjectPlugin } from "@/lib/native-project-binding"
import { useFeatureGate } from "@/lib/feature-gates"
import { FEATURE_GATES } from "../../../../shared/feature-gates"
import type { NativeNodeCatalog, NativeNodePlan } from "../../../../shared/node-composition"
import type { HarnessProjectListItem } from "../../../../shared/harness-board-types"

export function NativeNodeComposer({
  threadId,
  workspace,
  initialProjectId,
  pluginId,
  initialOpen = false,
  onContinue
}: {
  threadId: string
  workspace: string
  initialProjectId?: string
  pluginId?: string
  initialOpen?: boolean
  onContinue?: () => void
}) {
  const available = useFeatureGate(FEATURE_GATES.projectMode)
  const [open, setOpen] = useState(initialOpen)
  return (
    <section className="rounded-xl border p-4">
      <h3 className="font-medium">已安装插件的项目流程</h3>
      <p className="my-2 text-sm text-muted-foreground">
        查看所选项目实际使用的步骤。插件提供自选模板时，可为本次需求调整步骤；固定模板沿原项目入口使用。
        这里不会生成新插件。需要组合业务 Mods 和界面扩展，请使用“从 Mods 组装新插件”。
      </p>
      {!available.enabled ? (
        <p className="text-sm">当前应用尚未开放项目模式，开放后可在这里选择项目步骤。</p>
      ) : (
        <Button variant="outline" onClick={() => setOpen(!open)}>
          {open ? "收起项目步骤" : "查看项目流程"}
        </Button>
      )}
      {open && available.enabled && (
        <NativeNodeSelection
          key={JSON.stringify([threadId, workspace, initialProjectId, pluginId])}
          threadId={threadId}
          workspace={workspace}
          initialProjectId={initialProjectId}
          pluginId={pluginId}
          onContinue={onContinue}
        />
      )}
    </section>
  )
}

function NativeNodeSelection({
  threadId,
  workspace,
  initialProjectId,
  pluginId,
  onContinue
}: {
  threadId: string
  workspace: string
  initialProjectId?: string
  pluginId?: string
  onContinue?: () => void
}) {
  const scope = { threadId, expectedWorkspace: workspace }
  const ownerAccount = useRef(useAppStore.getState().accountRevision).current
  const [projects, setProjects] = useState<HarnessProjectListItem[]>([])
  const [inventory, setInventory] = useState<HarnessProjectListItem[]>([])
  const [installed, setInstalled] = useState<InstalledProjectPlugin>()
  const [inventoryRead, setInventoryRead] = useState(false)
  const [inventoryError, setInventoryError] = useState("")
  const [projectId, setProjectId] = useState(initialProjectId ?? "")
  const [catalog, setCatalog] = useState<NativeNodeCatalog | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [includeOptionalDependencies, setIncludeOptionalDependencies] = useState(true)
  const [templateId, setTemplateId] = useState("")
  const [plan, setPlan] = useState<NativeNodePlan | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(true)
  const sequence = useRef(0)
  const [refreshRevision, setRefreshRevision] = useState(0)
  useEffect(() => {
    const requests = sequence
    const request = ++sequence.current
    setBusy(true)
    setInventoryError("")
    setInventoryRead(false)
    setCatalog(null)
    setPlan(null)
    void Promise.all([
      window.api.nodeComposition.projects(scope),
      pluginId
        ? Promise.all([window.api.harnessBoard.listProjects(), window.api.plugins.list()])
          .then(([all, plugins]) => ({ all, plugin: plugins.find((item) => item.id === pluginId), error: "" }))
          .catch((cause) => ({ all: [], plugin: undefined, error: String(cause.message ?? cause) }))
        : Promise.resolve(null)
    ])
      .then(([items, details]) => {
        if (request !== sequence.current) return
        if (ownerAccount !== useAppStore.getState().accountRevision)
          throw Error("账号已变化，请在当前账号重新打开项目流程。")
        if (details) {
          setInventory(details.all)
          setInstalled(details.plugin)
          setInventoryRead(!details.error)
          setInventoryError(details.error)
        }
        if (pluginId) items = items.filter((item) => item.harnessAdapter.id === pluginId)
        if (details && !details.error && !details.plugin?.enabled) items = []
        setProjects(items)
        if (initialProjectId && items.some((item) => item.projectId === initialProjectId)) {
          void load(initialProjectId)
        } else if (initialProjectId) {
          setProjectId("")
          setError("当前聊天目录中该项目暂不可用，请查看绑定详情或进入原项目核对插件和兼容性。")
        }
      })
      .catch((cause) => {
        if (request === sequence.current) setError(String(cause.message ?? cause))
      })
      .finally(() => {
        if (request === sequence.current) setBusy(false)
      })
    return () => {
      ++requests.current
    }
    // The owner keys this component by thread and workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshRevision])
  const related = pluginId && inventoryRead
    ? nativeProjectBindings(pluginId, workspace, projects, inventory, installed) : []
  async function openProject(project?: HarnessProjectListItem) {
    const request = sequence.current
    const current = captureConfigurationScope({ threadId, workspace })
    const assertCurrent = () => {
      if (request !== sequence.current || !current() || ownerAccount !== useAppStore.getState().accountRevision)
        throw Error("聊天、目录或账号已变化，请重新读取项目绑定。")
    }
    setError("")
    try {
      assertCurrent()
      if (pluginId && installed) {
        const live = (await window.api.plugins.list()).find((item) => item.id === pluginId)
        assertCurrent()
        if (!live || !live.enabled || installedProjectPluginIdentity(live) !== installedProjectPluginIdentity(installed))
          throw Error("插件已停用、移除或版本已变化，请重新读取项目绑定。")
      }
      if (project) openExistingPluginProject(project, scope)
      else if (installed) openDerivedProject(installed.id, installed.name, scope)
      onContinue?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  async function load(projectId: string) {
    const request = ++sequence.current
    setCatalog(null)
    setPlan(null)
    setError("")
    setProjectId(projectId)
    if (!projectId) {
      setBusy(false)
      return
    }
    setBusy(true)
    try {
      if (ownerAccount !== useAppStore.getState().accountRevision)
        throw Error("账号已变化，请在当前账号重新打开项目流程。")
      const value = await window.api.nodeComposition.catalog({ ...scope, projectId })
      if (request !== sequence.current) return
      if (ownerAccount !== useAppStore.getState().accountRevision)
        throw Error("账号已变化，请在当前账号重新打开项目流程。")
      const template = value.config.templates.find((item) => item.templateType === "custom") ??
        value.config.templates[0]
      setCatalog(value)
      setTemplateId(template?.id ?? "")
      setSelected(template?.templateType === "custom" ? template.requiredNodes : template?.nodes ?? [])
    } catch (cause) {
      if (request === sequence.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === sequence.current) setBusy(false)
    }
  }
  async function preview() {
    if (!catalog || busy || !custom) return
    const request = ++sequence.current
    setBusy(true)
    setError("")
    setPlan(null)
    try {
      const value = await window.api.nodeComposition.preview({
        ...scope,
        projectId: catalog.project.projectId,
        templateId,
        selected,
        includeOptionalDependencies
      })
      if (request === sequence.current) setPlan(value)
    } catch (cause) {
      if (request === sequence.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === sequence.current) setBusy(false)
    }
  }
  const template = catalog?.config.templates.find((item) => item.id === templateId)
  const custom = template?.templateType === "custom"
  const required = new Set(template?.requiredNodes ?? [])
  const selectedProject = projects.find((item) => item.projectId === projectId)
  const selectedBinding = related.find((item) => item.project.projectId === projectId)
  const visibleNodes = custom || !template
    ? catalog?.nodes ?? []
    : (template.nodes ?? []).flatMap((id) => catalog?.nodes.find((node) => node.id === id) ?? [])
  return (
    <div className="mt-4 space-y-4" aria-label="项目节点组合">
      <label className="block text-sm">
        选择项目
        <select
          aria-label="选择节点所属项目"
          value={projectId}
          disabled={busy}
          className="mt-1 block w-full rounded border bg-background p-2"
          onChange={(event) => void load(event.target.value)}
        >
          <option value="">请选择</option>
          {projects.map((project) => (
            <option key={project.projectId} value={project.projectId}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <Button size="sm" variant="outline" disabled={busy}
        onClick={() => setRefreshRevision((value) => value + 1)}>重新读取项目绑定</Button>
      {!busy && !projects.length && (
        <div className="space-y-2 text-sm">
          <p>{error ? "当前项目流程尚未读取成功，请重新核对绑定。"
            : pluginId ? "当前聊天目录没有可读取流程的关联项目。" : "当前聊天目录还没有可用项目。"}</p>
          <p className="break-all text-xs text-muted-foreground">当前聊天目录：{workspace}</p>
          {pluginId && inventoryRead && !installed && <p>所选插件已移除，请先重新安装并核对来源。</p>}
          {installed && !installed.enabled && <p>所选插件已停用。管理并明确启用后，再重新读取项目绑定。</p>}
          {pluginId && inventoryRead && !related.length && installed?.enabled &&
            <p>尚未找到使用此插件的活动项目。可以先创建独立项目，创建不会自动执行任务。</p>}
          {inventoryError && <p role="alert">项目绑定详情读取失败：{inventoryError}。请重新读取，不能据此认定没有项目。</p>}
          {related.map(({ project, reason, versionChanged, boundVersion }) => (
            <div className="space-y-1 rounded-lg border p-3" key={project.projectId}>
              <strong>{project.name}</strong>
              <p className="break-all text-xs text-muted-foreground">项目工作区：{project.workspacePath} / {project.projectDir}</p>
              <p>{reason === "other-workspace" ? "项目绑定在其他目录，请打开已绑定项目使用。"
                : reason === "incompatible" ? project.boardCompatibility.message || project.boardCompatibility.label
                  : reason === "disabled" ? "插件未启用。" : reason === "missing" ? "插件未安装。"
                    : "此项目暂未通过当前目录的流程检查，请进入原项目核对。"}</p>
              {versionChanged && <p>项目记录版本 {boundVersion}，与当前安装版本 {installed?.version} 不同。进入后将重新核对当前安装源码，项目可能暂不可用；这里不会迁移项目。</p>}
              <Button size="sm" variant="outline" disabled={!installed?.enabled}
                onClick={() => void openProject(project)}>打开已绑定项目：{project.name}</Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {installed?.enabled && <Button size="sm" onClick={() => void openProject()}>新建此插件项目</Button>}
            {pluginId && <Button size="sm" variant="outline" onClick={() => openPluginSettings(pluginId)}>管理所选插件</Button>}
          </div>
        </div>
      )}
      {busy && (
        <p role="status" className="text-sm">
          正在读取和检查项目步骤…
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {selectedBinding?.versionChanged && (
        <p role="status" className="text-sm text-amber-600">
          项目记录版本 {selectedBinding.boundVersion}，与当前安装版本 {installed?.version} 不同。
          进入后将重新核对当前安装源码，项目可能暂不可用；这里不会迁移项目。
        </p>
      )}
      {catalog && (
        <>
          {catalog.config.templates.length > 1 && (
            <label className="block text-sm">
              项目提供的流程模板
              <select aria-label="项目流程模板" value={templateId} disabled={busy}
                className="mt-1 block w-full rounded border bg-background p-2"
                onChange={(event) => {
                  const next = catalog.config.templates.find((item) => item.id === event.target.value)
                  setTemplateId(event.target.value)
                  setSelected(next?.templateType === "custom" ? next.requiredNodes : next?.nodes ?? [])
                  setPlan(null)
                }}>
                {catalog.config.templates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label || item.id} · {item.templateType === "custom" ? "支持自选" : "固定流程"}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="text-sm text-muted-foreground">
            {custom
              ? "此版本支持为本次需求自选步骤，前置检查和人工确认会保留。"
              : template
                ? `当前模板“${template.label || template.id}”使用固定流程，以下为此模板的步骤。可进入原项目创建需求，原检查和人工确认会保留。`
                : "此插件未提供可读取的流程模板。以下为可用步骤，可进入原项目核对本次需求的流程。"}
          </p>
          {!custom && template && visibleNodes.length === 0 && (
            <p className="text-sm text-muted-foreground">此模板未声明可读取的步骤，请进入原项目核对实际流程。</p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {visibleNodes.map((node, index) => (
              <label key={node.id} className="min-w-0 space-y-1 rounded-lg border p-3 text-sm">
                <span className="flex gap-2">
                  {custom ? <input
                    type="checkbox"
                    disabled={busy || required.has(node.id)}
                    checked={selected.includes(node.id)}
                    onChange={(event) => {
                      setPlan(null)
                      setSelected((old) =>
                        event.target.checked
                          ? [...old, node.id]
                          : old.filter((id) => id !== node.id)
                      )
                    }}
                  /> : <span className="text-muted-foreground">{index + 1}.</span>}
                  <strong>{node.label}</strong>
                  {custom && required.has(node.id) && <span>（必选）</span>}
                </span>
                <p className="text-muted-foreground">{node.description}</p>
                {(node.inputs.length > 0 || node.outputs.length > 0) && (
                  <details>
                    <summary>需要哪些资料，会得到什么</summary>
                    <p className="break-all">需要：{node.inputs.join("、") || "按原步骤要求"}</p>
                    <p className="break-all">产出：{node.outputs.join("、") || "按原步骤要求"}</p>
                  </details>
                )}
              </label>
            ))}
          </div>
          {custom && <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="自动加入可选输入的上游步骤"
              disabled={busy}
              checked={includeOptionalDependencies}
              onChange={(event) => {
                setPlan(null)
                setIncludeOptionalDependencies(event.target.checked)
              }}
            />
            <span>
              自动加入可选输入的上游步骤
              <span className="block text-muted-foreground">
                关闭后，省略可选输入；原插件明确支持降级的输入会逐项提示。必选步骤和原检查继续保留。
              </span>
            </span>
          </label>}
          {custom && <Button disabled={busy || !selected.length} onClick={() => void preview()}>
            检查并预览步骤
          </Button>}
        </>
      )}
      {selectedProject && (
        <Button variant="outline" disabled={busy} onClick={() => void openProject(selectedProject)}>
          在原项目中使用
        </Button>
      )}
      {plan && (
        <section aria-label="节点组合预览" className="space-y-3 rounded-lg border p-3 text-sm">
          <h4 className="font-medium">将按这个顺序执行</h4>
          <ol className="list-inside list-decimal space-y-1">
            {plan.ordered.map((id) => (
              <li key={id}>
                {plan.nodes.find((node) => node.id === id)?.label ?? id}
                {plan.added.includes(id) && "（为保留输入和检查自动补齐）"}
              </li>
            ))}
          </ol>
          <p>接下来为这组步骤创建需求。创建不会自动运行，原有阶段检查和审批继续生效。</p>
          {plan.optionalOmissions.length > 0 && (
            <div>
              <p>以下资料在原插件中为可选项，本次未启用：</p>
              <ul className="list-inside list-disc">
                {plan.optionalOmissions.map((item) => (
                  <li key={`${item.nodeId}:${item.path}`} className="break-all">
                    {plan.nodes.find((node) => node.id === item.nodeId)?.label}：{item.path}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.entryInputFallbacks?.length > 0 && (
            <div>
              <p>以下输入不再从上游步骤取得，须按原插件要求使用用户上下文或补齐资料：</p>
              <ul className="list-inside list-disc space-y-2">
                {plan.entryInputFallbacks.map((item) => (
                  <li key={`${item.nodeId}:${item.path}`} className="break-words">
                    {plan.nodes.find((node) => node.id === item.nodeId)?.label}：{item.path}
                    <p className="text-muted-foreground">{item.guidance}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Button
            disabled={busy}
            onClick={() => {
              const request = ++sequence.current
              setBusy(true)
              setError("")
              void openNativeNodePlan(scope, plan)
                .then(() => {
                  if (request === sequence.current) onContinue?.()
                })
                .catch((cause) => {
                  if (request === sequence.current)
                    setError(cause instanceof Error ? cause.message : String(cause))
                })
                .finally(() => {
                  if (request === sequence.current) setBusy(false)
                })
            }}
          >
            在项目里创建需求
          </Button>
        </section>
      )}
    </div>
  )
}
