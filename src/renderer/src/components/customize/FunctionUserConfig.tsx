import type { FunctionConfigApi } from "../../../../shared/mods/v2/config-api"
import { useEffect, useRef, useState, type CSSProperties } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import type { FunctionUserConfigView } from "../../../../shared/mods/v2/user-config-view"
import type { FunctionConfigValue } from "../../../../shared/mods/v2/config"
import { useConfigurationDraft } from "@/lib/configuration-target"
import {
  functionUserConfigDraft,
  equalFunctionUserConfigDraft,
  type FunctionUserConfigDraft
} from "../../lib/user-config-draft"

const stateLabels = {
  inactive: "将在启用时应用",
  applied: "当前对话已应用",
  pending: "已保存，等待应用到当前聊天",
  failed: "已保存，应用未完成",
  stopped: "当前组合已停止，可在下方重新加载"
}

const secretLabels = {
  saved: "已安全保存。重新填写会替换原值。",
  default: "使用作者默认值。重新填写可覆盖它。",
  unset: "尚未填写。",
  unavailable: "当前系统无法安全保存或读取此参数；其他参数仍可使用。",
  invalid: "安全保存的值无法读取，请重新填写或清除。",
  changed: "参数类型已改变，请重新填写或清除原值。"
}

/** Official plugin parameters are saved independently of the reusable Claw composition. */
export function FunctionUserConfig({
  threadId,
  pluginId,
  onSaved,
  expectedWorkspace,
  initiallyOpen = false,
  expectedDigest,
  focusKey,
  api = window.api.mods,
  hideRuntimeControls = false
}: {
  threadId: string
  pluginId: string
  expectedWorkspace?: string
  initiallyOpen?: boolean
  expectedDigest?: string
  focusKey?: string
  api?: FunctionConfigApi
  hideRuntimeControls?: boolean
  onSaved?(): void
}) {
  return (
    <FunctionUserConfigEditor
      key={JSON.stringify([threadId, pluginId, expectedWorkspace])}
      threadId={threadId}
      pluginId={pluginId}
      onSaved={onSaved}
      expectedWorkspace={expectedWorkspace}
      initiallyOpen={initiallyOpen}
      expectedDigest={expectedDigest}
      focusKey={focusKey}
      api={api}
      hideRuntimeControls={hideRuntimeControls}
    />
  )
}

function FunctionUserConfigEditor({
  threadId,
  pluginId,
  onSaved,
  expectedWorkspace,
  initiallyOpen,
  expectedDigest,
  focusKey,
  api = window.api.mods,
  hideRuntimeControls = false
}: {
  threadId: string
  pluginId: string
  expectedWorkspace?: string
  initiallyOpen?: boolean
  expectedDigest?: string
  focusKey?: string
  api?: FunctionConfigApi
  hideRuntimeControls?: boolean
  onSaved?(): void
}) {
  const [open, setOpen] = useState(initiallyOpen === true)
  const [view, setView] = useState<FunctionUserConfigView | null>(null)
  const [drafts, setDrafts] = useState<Record<string, FunctionUserConfigDraft>>({})
  const [picking, setPicking] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState("")
  const generation = useRef(0)
  const saveSequence = useRef(0)
  const saving = useRef(false)
  const draftVersions = useRef(new Map<string, number>())
  const editVersions = useRef(new Map<string, number>())
  const savedEditVersions = useRef(new Map<string, number>())
  const panelVersion = useRef(0)
  const pickerSequence = useRef(0)
  const nextDraftVersion = (key: string) => {
    const next = (draftVersions.current.get(key) ?? 0) + 1
    draftVersions.current.set(key, next)
    return next
  }
  const currentValues = useRef({ view, drafts })
  useConfigurationDraft(
    { threadId, workspace: view?.workspace ?? expectedWorkspace ?? null },
    !!view &&
      view.fields.some(
        (field) => !equalFunctionUserConfigDraft(drafts[field.key], functionUserConfigDraft(field))
      ),
    (busy !== null && busy !== "loading") || picking !== null
  )
  currentValues.current = { view, drafts }
  const accept = (next: FunctionUserConfigView, preserveDrafts = false, savedKey?: string) => {
    if (expectedWorkspace !== undefined && next.workspace !== expectedWorkspace)
      throw Error("MODS_SCOPE_CHANGED")
    if (expectedDigest !== undefined && next.digest !== expectedDigest)
      throw Error("MODS_CONFIG_SOURCE_CHANGED")
    const previous = currentValues.current
    if (
      previous.view?.workspace === next.workspace &&
      previous.view.digest === next.digest &&
      previous.view.savedRevision > next.savedRevision
    )
      return
    if (
      previous.view?.workspace !== next.workspace ||
      previous.view.digest !== next.digest ||
      previous.view.savedRevision !== next.savedRevision
    )
      for (const field of next.fields) nextDraftVersion(field.key)
    setView(next)
    const updated = Object.fromEntries(
      next.fields.map((field) => {
        const before = previous.view?.fields.find((item) => item.key === field.key)
        const initial = before ? functionUserConfigDraft(before) : undefined
        const retained =
          preserveDrafts &&
          field.key !== savedKey &&
          before?.type === field.type &&
          previous.view?.digest === next.digest &&
          previous.view.workspace === next.workspace &&
          Object.hasOwn(previous.drafts, field.key) &&
          (field.sensitive
            ? (editVersions.current.get(field.key) ?? 0) !==
              (savedEditVersions.current.get(field.key) ?? 0)
            : !equalFunctionUserConfigDraft(previous.drafts[field.key], initial))
        if (field.sensitive && !retained)
          savedEditVersions.current.set(field.key, editVersions.current.get(field.key) ?? 0)
        return [field.key, retained ? previous.drafts[field.key] : functionUserConfigDraft(field)]
      })
    )
    currentValues.current = { view: next, drafts: updated }
    setDrafts(updated)
  }
  const edit = (key: string, value: FunctionUserConfigDraft) => {
    editVersions.current.set(key, (editVersions.current.get(key) ?? 0) + 1)
    nextDraftVersion(key)
    const next = { ...currentValues.current.drafts, [key]: value }
    currentValues.current = { ...currentValues.current, drafts: next }
    setDrafts(next)
  }
  const pick = async (field: FunctionUserConfigView["fields"][number]) => {
    const original = currentValues.current.view
    if (!original) return
    const version = nextDraftVersion(field.key),
      panel = panelVersion.current,
      request = ++pickerSequence.current
    setPicking(field.key)
    setError("")
    const current = () =>
      draftVersions.current.get(field.key) === version &&
      panelVersion.current === panel &&
      currentValues.current.view?.workspace === original.workspace &&
      currentValues.current.view.digest === original.digest &&
      currentValues.current.view.savedRevision === original.savedRevision
    try {
      const selected = await api.pickUserConfigPath(threadId, original, field.key)
      if (selected !== undefined && current()) edit(field.key, selected)
    } catch (failure) {
      if (current()) setError(String(failure))
    } finally {
      if (panelVersion.current === panel && pickerSequence.current === request) setPicking(null)
    }
  }
  useEffect(() => {
    if (!open) return
    let closed = false
    const load = (preserve = false) => {
      const current = ++generation.current
      if (!saving.current) setBusy("loading")
      setError("")
      void api
        .userConfig(threadId, pluginId, expectedWorkspace)
        .then((next) => {
          if (!closed && generation.current === current) accept(next, preserve)
        })
        .catch((failure) => {
          if (!closed && generation.current === current) setError(String(failure))
        })
        .finally(() => {
          if (!closed && generation.current === current && !saving.current) setBusy(null)
        })
    }
    load()
    const stop = window.api.mods.onConfigurationChanged(() => load(true))
    const invalidate = () => {
      generation.current++
      saveSequence.current++
      saving.current = false
      panelVersion.current++
    }
    return () => {
      closed = true
      invalidate()
      stop()
    }
  }, [open, pluginId, threadId, expectedWorkspace, expectedDigest, api])
  const save = async (field: FunctionUserConfigView["fields"][number], clear = false) => {
    if (!view) return
    if (
      field.sensitive &&
      !clear &&
      (editVersions.current.get(field.key) ?? 0) === (savedEditVersions.current.get(field.key) ?? 0)
    )
      return
    const current = ++saveSequence.current
    const submittedVersion = editVersions.current.get(field.key) ?? 0
    nextDraftVersion(field.key)
    const draft = drafts[field.key]
    let value: FunctionConfigValue = draft ?? (field.multiple ? [] : "")
    if (!clear && (field.type === "number" || field.type === "boolean") && value === "") {
      setError(`请为“${field.label}”选择或填写一个值。`)
      return
    }
    if (field.type === "number") value = Number(value)
    if (!clear && field.required && value === "") {
      setError(`请填写“${field.label}”。`)
      return
    }
    if (
      !clear &&
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        (field.min !== undefined && value < field.min) ||
        (field.max !== undefined && value > field.max))
    ) {
      setError(`“${field.label}”超出允许范围。`)
      return
    }
    setBusy(field.key)
    saving.current = true
    setError("")
    try {
      const next = await (field.sensitive
        ? api.saveSensitiveUserConfig(
            threadId,
            view,
            field.key,
            clear ? { operation: "clear" } : { operation: "set", value }
          )
        : api.saveUserConfig(threadId, view, field.key, value))
      if (
        saveSequence.current === current &&
        currentValues.current.view?.workspace === view.workspace &&
        currentValues.current.view.digest === view.digest &&
        next.workspace === view.workspace &&
        next.digest === view.digest
      ) {
        if (field.sensitive && (editVersions.current.get(field.key) ?? 0) === submittedVersion) {
          savedEditVersions.current.set(field.key, submittedVersion)
          // A successful older ACK still clears its input without rolling back a newer view.
          const updated = {
            ...currentValues.current.drafts,
            [field.key]: functionUserConfigDraft(field)
          }
          currentValues.current = { ...currentValues.current, drafts: updated }
          setDrafts(updated)
        }
        accept(
          next,
          true,
          (editVersions.current.get(field.key) ?? 0) === submittedVersion ? field.key : undefined
        )
        onSaved?.()
      }
    } catch (failure) {
      if (saveSequence.current === current) setError(String(failure))
    } finally {
      if (saveSequence.current === current) {
        saving.current = false
        setBusy(null)
      }
    }
  }
  const apply = async (reload = false) => {
    if (!view) return
    const current = ++saveSequence.current
    saving.current = true
    setBusy(reload ? "reloading" : "applying")
    setError("")
    try {
      const next = await (reload
        ? api.reloadUserConfig(threadId, view)
        : api.applyUserConfig(threadId, view))
      if (saveSequence.current === current) accept(next, true)
    } catch (failure) {
      if (saveSequence.current === current) setError(String(failure))
    } finally {
      if (saveSequence.current === current) {
        saving.current = false
        setBusy(null)
      }
    }
  }
  const migrate = async () => {
    if (!view?.migration?.canApply) return
    const current = ++saveSequence.current
    saving.current = true
    setBusy("migrating")
    setError("")
    try {
      const next = await api.migrateUserConfig(threadId, view)
      if (saveSequence.current === current) {
        accept(next, true)
        if (!next.migration) onSaved?.()
      }
    } catch (failure) {
      if (saveSequence.current === current) setError(String(failure))
    } finally {
      if (saveSequence.current === current) {
        saving.current = false
        setBusy(null)
      }
    }
  }
  return (
    <details
      data-desktop-selection-excluded
      open={open}
      onToggle={(event) => {
        panelVersion.current++
        setPicking(null)
        setOpen(event.currentTarget.open)
      }}
      className="w-full rounded-xl border border-border/70 bg-muted/15"
      data-function-user-config={pluginId}
    >
      <summary className="cursor-pointer px-4 py-3 text-xs font-medium">插件参数</summary>
      <div className="space-y-4 border-t border-border/60 px-4 py-4 text-xs">
        <p className="leading-5 text-muted-foreground">
          这些是插件的通用参数，同一项目中使用此插件的聊天共享。不修改的选项会保留原值。
        </p>
        {(view?.workspace || expectedWorkspace) && (
          <p className="break-all leading-5 text-muted-foreground" aria-label="参数配置目标">
            配置目标：{view?.workspace ?? expectedWorkspace}。当前聊天只显示此目标的实际应用状态。
          </p>
        )}
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">保存后何时生效？</summary>
          <p className="mt-2 leading-5">
            任务进行中会继续使用原设置，结束后再应用新设置。密钥等敏感内容不会显示原值；
            填写新值可替换，清除后使用作者的默认值。组合只保存功能选择，这些参数单独保存在项目中。
            修改参数不需要重新批准插件代码；插件代码更新后仍需重新确认权限。
          </p>
        </details>
        {view && (
          <p role="status" className="rounded-lg bg-background/70 px-3 py-2 text-muted-foreground">
            本聊天的应用状态：{stateLabels[view.state]}
            {view.error ? `：${view.error}` : ""}
          </p>
        )}
        {view?.migration && (
          <div
            role="status"
            className="space-y-2 rounded-lg border border-border p-3"
            aria-label="插件配置迁移"
          >
            <p>
              配置版本 {view.migration.fromVersion} → {view.migration.toVersion} 需要确认迁移。
            </p>
            <p>迁移保留兼容保存值；删除及密钥重命名需在本机确认。迁移完成后再保存或应用新配置。</p>
            {view.migration.changes.map((change, index) => (
              <p key={index}>
                {change.kind === "rename"
                  ? `重命名 ${change.from} → ${change.to}`
                  : `删除保存值 ${change.key}`}
              </p>
            ))}
            {view.migration.diagnostics.map((diagnostic, index) => (
              <p key={index}>{diagnostic}</p>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || !view.migration.canApply}
              onClick={() => void migrate()}
            >
              {busy === "migrating" ? "正在迁移…" : "核对并迁移配置"}
            </Button>
          </div>
        )}
        {!hideRuntimeControls && view && (view.state === "pending" || view.state === "failed") && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || !!view?.migration}
              onClick={() => void apply()}
            >
              {busy === "applying"
                ? "正在应用…"
                : view.state === "failed"
                  ? "重试应用"
                  : "应用已保存参数"}
            </Button>
            <span className="text-muted-foreground">
              当前任务运行时保留原参数，结束后自动应用。
            </span>
          </div>
        )}
        {!hideRuntimeControls &&
          view &&
          (view.state === "pending" || view.state === "failed" || view.state === "stopped") && (
            <div className="space-y-2 rounded-lg border border-border/70 bg-background/50 p-3">
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || !!view?.migration}
                onClick={() => void apply(true)}
              >
                {busy === "reloading" ? "正在重新加载…" : "重新加载当前组合"}
              </Button>
              <p className="leading-5 text-muted-foreground">
                重新加载这段聊天正在使用的插件，保留已保存的设置和数据。启动时的操作可能再次执行，
                原聊天任务不会重跑。若上次操作中断，请先核对结果；当前任务结束后再重试。
                {view.state === "stopped" ? "普通聊天仍可使用。" : ""}
              </p>
            </div>
          )}
        {error && (
          <p role="alert" className="break-words text-destructive">
            {error}
          </p>
        )}
        {!view && !error && <p className="text-muted-foreground">正在读取参数…</p>}
        {view?.fields
          .filter((field) => !focusKey || field.key === focusKey)
          .map((field) => (
            <div key={field.key} className="space-y-2 rounded-lg border bg-background/50 p-3">
              <label
                htmlFor={`plugin-param-${pluginId}-${field.key}`}
                className="block font-medium"
              >
                {field.label}
                {field.required ? " · 必填" : ""}
              </label>
              <p className="leading-5 text-muted-foreground">{field.description}</p>
              {field.supported ? (
                <div className="flex flex-wrap items-center gap-2">
                  {field.multiple ? (
                    <div className="w-full space-y-2" data-config-list={field.key}>
                      {(Array.isArray(drafts[field.key])
                        ? (drafts[field.key] as string[])
                        : []
                      ).map((item, index) => (
                        <div key={index} className="flex items-start gap-2">
                          <textarea
                            id={index === 0 ? `plugin-param-${pluginId}-${field.key}` : undefined}
                            aria-label={`${field.label} 第 ${index + 1} 项`}
                            rows={Math.min(4, Math.max(1, item.split("\n").length))}
                            style={
                              field.sensitive
                                ? ({ WebkitTextSecurity: "disc" } as CSSProperties)
                                : undefined
                            }
                            autoComplete={field.sensitive ? "off" : undefined}
                            className="min-w-0 flex-1 resize-y rounded-md border bg-background px-3 py-2 text-sm"
                            value={item}
                            disabled={busy !== null || !!view?.migration}
                            onChange={(event) =>
                              edit(
                                field.key,
                                (drafts[field.key] as string[]).map((text, at) =>
                                  at === index ? event.target.value : text
                                )
                              )
                            }
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy !== null || !!view?.migration}
                            aria-label={`删除${field.label}第 ${index + 1} 项`}
                            onClick={() =>
                              edit(
                                field.key,
                                (drafts[field.key] as string[]).filter((_, at) => at !== index)
                              )
                            }
                          >
                            删除
                          </Button>
                        </div>
                      ))}
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            busy !== null ||
                            !!view?.migration ||
                            (Array.isArray(drafts[field.key]) &&
                              (drafts[field.key] as string[]).length >= 256)
                          }
                          onClick={() =>
                            edit(field.key, [
                              ...(Array.isArray(drafts[field.key])
                                ? (drafts[field.key] as string[])
                                : []),
                              ""
                            ])
                          }
                        >
                          添加一项
                        </Button>
                        <span className="text-muted-foreground">
                          每项独立保存，逗号和换行保留在该项内。
                        </span>
                      </div>
                      {typeof field.value === "string" && field.value !== "" && (
                        <p className="text-muted-foreground">
                          现有值是单个文本；点击保存后才改为列表。
                        </p>
                      )}
                    </div>
                  ) : field.sensitive && field.type === "boolean" ? (
                    <select
                      id={`plugin-param-${pluginId}-${field.key}`}
                      value={
                        drafts[field.key] === true
                          ? "true"
                          : drafts[field.key] === false
                            ? "false"
                            : ""
                      }
                      disabled={busy !== null || !!view?.migration}
                      className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
                      onChange={(event) => edit(field.key, event.target.value === "true")}
                    >
                      <option value="" disabled>
                        请选择新值
                      </option>
                      <option value="true">启用</option>
                      <option value="false">关闭</option>
                    </select>
                  ) : field.type === "boolean" ? (
                    <Switch
                      id={`plugin-param-${pluginId}-${field.key}`}
                      checked={drafts[field.key] === true}
                      disabled={busy !== null || !!view?.migration}
                      onCheckedChange={(value) => edit(field.key, value)}
                    />
                  ) : field.options ? (
                    <select
                      id={`plugin-param-${pluginId}-${field.key}`}
                      value={String(drafts[field.key] ?? "")}
                      disabled={busy !== null || !!view?.migration}
                      className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
                      onChange={(event) => edit(field.key, event.target.value)}
                    >
                      {!field.value && (
                        <option value="" disabled>
                          请选择
                        </option>
                      )}
                      {field.options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={`plugin-param-${pluginId}-${field.key}`}
                      className="min-w-0 flex-1"
                      type={
                        field.sensitive ? "password" : field.type === "number" ? "number" : "text"
                      }
                      autoComplete={field.sensitive ? "new-password" : undefined}
                      placeholder={field.sensitive ? "填写新值；不填写会保留原值" : undefined}
                      value={String(drafts[field.key] ?? "")}
                      disabled={busy !== null || !!view?.migration}
                      min={field.min}
                      max={field.max}
                      onChange={(event) => edit(field.key, event.target.value)}
                    />
                  )}
                  {!field.sensitive && (field.type === "file" || field.type === "directory") && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null || !!view?.migration}
                      onClick={() => void pick(field)}
                    >
                      {picking === field.key
                        ? "正在选择…"
                        : field.type === "directory"
                          ? "选择目录"
                          : "选择文件"}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      busy !== null ||
                      !!view?.migration ||
                      (field.sensitive &&
                        (editVersions.current.get(field.key) ?? 0) ===
                          (savedEditVersions.current.get(field.key) ?? 0))
                    }
                    onClick={() => void save(field)}
                  >
                    保存{busy === field.key ? "中…" : ""}
                  </Button>
                  {field.sensitive && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={
                        busy !== null ||
                        !!view?.migration ||
                        field.secretState === "unset" ||
                        field.secretState === "default"
                      }
                      onClick={() => void save(field, true)}
                    >
                      清除已保存值
                    </Button>
                  )}
                </div>
              ) : (
                <p className="text-muted-foreground">
                  {field.sensitive && field.secretState
                    ? secretLabels[field.secretState]
                    : "此参数需要专用输入，普通参数表单暂不处理。"}
                </p>
              )}
              {field.sensitive && field.supported && field.secretState && (
                <p className="leading-5 text-muted-foreground">
                  {secretLabels[field.secretState]}
                  {field.effectiveConfigured ? " 当前运行实例已配置。" : ""}
                  {field.required && " 清除后没有默认值时，需要重新填写才能启用。"}
                </p>
              )}
              {(view.state === "pending" || view.state === "failed") &&
                field.effectiveValue !== undefined &&
                !field.sensitive &&
                field.supported && (
                  <p className="break-words text-muted-foreground">
                    当前运行值：
                    {Array.isArray(field.effectiveValue)
                      ? JSON.stringify(field.effectiveValue)
                      : String(field.effectiveValue)}
                  </p>
                )}
            </div>
          ))}
      </div>
    </details>
  )
}
