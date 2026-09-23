import { useCallback, useEffect, useRef, useState } from "react"
import type { ModWorkspaceStatus } from "../../../../shared/mods/types"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"
import { ModsAudit } from "./ModsAudit"
import { ModsSettingsGate } from "./ModsSettingsGate"
import { FunctionCompletionPolicy } from "./FunctionCompletionPolicy"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "@/components/ui/dialog"

async function readWorkspaceStatus(threadId: string | null): Promise<ModWorkspaceStatus | null> {
  if (!threadId) return null
  try {
    return await window.api.mods.status(threadId)
  } catch (error) {
    if (String(error).includes("MODS_WORKSPACE_REQUIRED")) return null
    throw error
  }
}

export function ModsPanel({ threadId }: { threadId: string | null }): React.JSX.Element {
  return (
    <ModsSettingsGate>
      <UnlockedModsPanel threadId={threadId} />
    </ModsSettingsGate>
  )
}

function UnlockedModsPanel({ threadId }: { threadId: string | null }): React.JSX.Element {
  const uploadInput = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState("")
  const [installed, setInstalled] = useState<Awaited<ReturnType<typeof window.api.plugins.list>>>(
    []
  )
  const [deleteTarget, setDeleteTarget] = useState<{ pluginId: string; name: string } | null>(null)
  const [status, setStatus] = useState<ModWorkspaceStatus | null>(null)
  const [globalEnabled, setGlobalEnabled] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const installedMods = installed.filter(
    (plugin) =>
      (plugin.modCount ?? 0) > 0 ||
      status?.functionMods?.some((mod) => mod.pluginId === plugin.id) ||
      status?.mods.some((mod) => mod.pluginId === plugin.id)
  )
  const refresh = useCallback(async () => {
    setInstalled(await window.api.plugins.list())
    setGlobalEnabled(await window.api.mods.globalEnabled())
    setStatus(await readWorkspaceStatus(threadId))
  }, [threadId])
  useEffect(() => {
    let live = true
    setStatus(null)
    setError("")
    void window.api.plugins.list().then(
      (values) => {
        if (live) setInstalled(values)
      },
      () => {
        if (live) setError("无法读取已安装的 Mods。")
      }
    )
    window.api.mods.globalEnabled().then(
      (value) => {
        if (live) setGlobalEnabled(value)
      },
      () => {
        if (live) setError("无法读取 Mods 总开关状态。")
      }
    )
    if (threadId)
      readWorkspaceStatus(threadId).then(
        (value) => {
          if (live) setStatus(value)
        },
        () => {
          if (live) setError("无法读取项目 Mods 状态，请重试。")
        }
      )
    return () => {
      live = false
    }
  }, [threadId])
  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await action()
      await refresh()
      window.dispatchEvent(new Event("mods:configuration-changed"))
    } catch (error) {
      setError(error instanceof Error ? error.message : "操作失败")
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="w-full border-b p-4 space-y-3 text-sm" data-mods-settings>
      <div className="space-y-3">
        <div>
          <div className="font-medium">Function Mods</div>
          <p className="text-xs text-muted-foreground">
            上传 ZIP 或选择本地文件夹安装 Mods 插件，在这里管理授权、运行状态和卸载。
            安装不会自动开启 Mods；需要在项目中授权后使用。同名同作者插件会更新。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={uploadInput}
            type="file"
            accept=".zip"
            aria-label="选择 Mods ZIP 文件"
            className="hidden"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ""
              if (!file) return
              void run(async () => {
                if (!file.name.toLowerCase().endsWith(".zip")) throw new Error("仅支持 .zip 文件")
                const result = await window.api.plugins.install(
                  await file.arrayBuffer(),
                  file.name,
                  "local",
                  undefined,
                  true
                )
                if (!result.success) throw new Error(result.error || "安装失败")
                useAppStore.getState().bumpPluginVersion()
                setNotice(
                  `已安装 ${result.pluginName ?? "Mods 插件"}。安装未改变运行开关，请在项目中检查授权状态。`
                )
              })
            }}
          />
          <Button size="sm" disabled={busy} onClick={() => uploadInput.current?.click()}>
            上传 Mods（ZIP）
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await window.api.plugins.installFromDir(true)
                if (!result.success) {
                  if (result.error === "已取消") return
                  throw new Error(result.error || "安装失败")
                }
                useAppStore.getState().bumpPluginVersion()
                setNotice(
                  `已安装 ${result.pluginName ?? "Mods 插件"}。安装未改变运行开关，请在项目中检查授权状态。`
                )
              })
            }
          >
            从文件夹安装
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await window.api.mods.installExamples()
                useAppStore.getState().bumpPluginVersion()
              })
            }
          >
            安装示范 Mods
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          请选择包含插件清单、模块声明和源码的完整插件包；不能直接上传单个脚本。
        </p>
        {notice && (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
      </div>
      <div className="rounded border p-3 space-y-1">
        <label className="flex items-center gap-2 font-medium">
          <input
            type="checkbox"
            checked={globalEnabled}
            disabled={busy}
            onChange={(event) =>
              void run(async () => {
                const value = await window.api.mods.configureGlobal(event.target.checked)
                setGlobalEnabled(value)
              })
            }
          />
          启用 Mods 功能（应用级）
        </label>
        <p className="text-xs text-muted-foreground">
          默认关闭。解锁设置不会自动开启；开启后还需项目授权。
        </p>
      </div>
      <div className="space-y-2" data-installed-mods>
        <h3 className="font-medium">已安装的 Mods 插件</h3>
        <p className="text-xs text-muted-foreground">
          无需开启 Mods 或打开项目即可卸载。卸载作用于整个来源插件。
        </p>
        {installedMods.map((plugin) => (
          <div
            key={plugin.id}
            className="flex items-center justify-between gap-3 rounded border p-3"
            data-installed-mod-id={plugin.id}
          >
            <span>{plugin.name}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setError("")
                setDeleteTarget({ pluginId: plugin.id, name: plugin.name })
              }}
            >
              卸载
            </Button>
          </div>
        ))}
        {installedMods.length === 0 && (
          <p className="text-xs text-muted-foreground">尚未安装 Mods 插件。</p>
        )}
      </div>
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>卸载 Mods 插件</DialogTitle>
            <DialogDescription>
              确认卸载「{deleteTarget?.name}」的整个来源插件？其中的 Mods、Skills、MCP 和 Hooks
              会一并移除，相关 Mods 命令与面板停止运行；其他插件保留。审计记录和已保存的 Mods
              数据不清除。
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !deleteTarget}
              onClick={() => {
                if (!deleteTarget) return
                const target = deleteTarget
                void run(async () => {
                  const result = await window.api.plugins.delete(target.pluginId)
                  if (!result.success) throw new Error(result.error || "卸载失败")
                  setDeleteTarget(null)
                  useAppStore.getState().bumpPluginVersion()
                })
              }}
            >
              确认卸载
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {!status && (
        <p className="text-muted-foreground">
          为当前会话选择项目目录后配置权限；安装和卸载无需项目目录。
        </p>
      )}
      {error && !deleteTarget && (
        <p role="alert" className="text-destructive break-all">
          {error}
        </p>
      )}
      {status?.recovery && (
        <p role="alert" className="text-destructive">
          Mods 控制记录或组织策略不可用，工具执行已暂停（{status.recovery}
          ）。请关闭应用并联系管理员检查控制库和部署策略；保留原数据库及 WAL
          文件，从已核实的完整备份恢复。不要删除数据库重新授权。
        </p>
      )}
      {status && !status.recovery && threadId && (
        <>
          <p className="text-xs text-muted-foreground break-all">作用目录：{status.workspace}</p>
          <div className="flex flex-wrap gap-5">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={status.enabled}
                disabled={busy || !globalEnabled}
                onChange={(event) =>
                  void run(() =>
                    window.api.mods.configure(threadId, event.target.checked, status.outputPolicy)
                  )
                }
              />
              启用项目 Mods
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={status.outputPolicy}
                disabled={busy || !globalEnabled || status.policy?.required}
                onChange={(event) =>
                  void run(() =>
                    window.api.mods.configure(threadId, status.enabled, event.target.checked)
                  )
                }
              />
              启用宿主输出保护{status.policy?.required ? "（组织要求）" : ""}
            </label>
          </div>
          {status.outputPolicy && (
            <p className="text-xs text-muted-foreground">
              检查工具结果中的常见凭据；后台输出通过完整检查后显示。不支持检查的内容会被隐藏。
            </p>
          )}
          {status.policy && (
            <p className="text-xs text-muted-foreground break-all">
              策略版本：{status.policy.id} · {status.policy.digest.slice(0, 16)}
            </p>
          )}
          <ModsAudit key={threadId} threadId={threadId} />
          {(status.functionMods?.length ?? 0) > 0 && (
            <details open>
              <summary className="cursor-pointer">
                Function Mods（{status.functionMods!.length}）
              </summary>
              <p className="text-xs text-muted-foreground mt-2">
                该插件提供命令、项目偏好、交互面板和 Client
                组件，调整模型使用工具的行为，调用已配置的模型。
                授权绑定以下版本，源码变化后需要重新授权。
              </p>
              <div className="mt-2 space-y-2">
                {status.functionMods!.map((mod) => (
                  <div
                    key={mod.pluginId}
                    className="rounded border p-3 space-y-2"
                    data-function-mod-id={mod.name}
                  >
                    <div className="flex justify-between gap-3">
                      <strong>{mod.name}</strong>
                      <span>
                        {
                          {
                            ready: "已授权",
                            disabled: "插件已禁用",
                            "needs-approval": "等待授权",
                            invalid: "插件无效"
                          }[mod.state]
                        }
                      </span>
                    </div>
                    <p className="text-xs">
                      允许注册命令和主助手的自定义工具、读取项目文件与会话标识、保存偏好、打开交互组件、调用或拦截工具及调用已配置的模型。
                      写文件和执行命令仍需批准最终参数；即时查询命令不能执行写操作。
                      模型调用自定义工具时可读取项目，不能借此自动执行写操作。
                      模型请求会产生实际用量，限每插件每项目每分钟 30 次及 32768 个预留输出 Token。
                    </p>
                    <p className="text-xs font-mono break-all">
                      版本摘要：{mod.digest ?? mod.error}
                    </p>
                    {mod.state === "needs-approval" && mod.digest && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            window.api.mods.approveFunction(threadId, mod.pluginId, mod.digest!)
                          )
                        }
                      >
                        授权以上能力
                      </Button>
                    )}
                    {mod.state === "ready" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(() => window.api.mods.revokeFunction(threadId, mod.name))
                        }
                      >
                        撤销权限
                      </Button>
                    )}
                    <FunctionCompletionPolicy
                      threadId={threadId}
                      plugin={mod.name}
                      disabled={busy || mod.state !== "ready"}
                    />
                  </div>
                ))}
              </div>
            </details>
          )}
          <details>
            <summary className="cursor-pointer">模块与权限（{status.mods.length}）</summary>
            <div className="max-h-64 overflow-auto mt-2 space-y-2">
              {status.mods.map((mod) => (
                <div
                  key={mod.pluginId}
                  className="rounded border p-3 space-y-1"
                  data-mod-id={mod.manifest?.id}
                >
                  <div className="flex justify-between gap-3">
                    <strong>{mod.manifest?.name ?? mod.pluginId}</strong>
                    <span>
                      {
                        {
                          ready: "已授权",
                          disabled: "插件已禁用",
                          "needs-approval": "等待授权",
                          invalid: "清单无效"
                        }[mod.state]
                      }
                    </span>
                  </div>
                  {mod.manifest && (
                    <>
                      <p className="text-xs">增强工具：{mod.manifest.tools.join("、") || "无"}</p>
                      <p className="text-xs">
                        读取能力：{mod.manifest.permissions.readTools.join("、") || "无"}
                        ；执行能力：{mod.manifest.permissions.writeTools.join("、") || "无"}
                      </p>
                      <p className="text-xs">
                        上下文：{mod.manifest.permissions.context.join("、") || "无"}
                        ；插件状态存储：{mod.manifest.permissions.store ? "允许" : "不申请"}
                        ；文本产物：{mod.manifest.permissions.artifacts ? "允许" : "不申请"}
                      </p>
                    </>
                  )}
                  <p className="text-xs font-mono break-all">版本摘要：{mod.digest ?? mod.error}</p>
                  {mod.state === "needs-approval" && mod.digest && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(() => window.api.mods.approve(threadId, mod.pluginId, mod.digest!))
                      }
                    >
                      授权以上权限
                    </Button>
                  )}
                  {mod.state === "ready" && mod.manifest && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(() => window.api.mods.revoke(threadId, mod.manifest!.id))
                      }
                    >
                      撤销权限
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </details>
          {status.diagnostics.length > 0 && (
            <details>
              <summary>运行诊断</summary>
              {status.diagnostics.map((item, index) => (
                <p className="text-xs" key={`${item.at}-${index}`}>
                  {item.modId} · {item.code}
                </p>
              ))}
            </details>
          )}
        </>
      )}
    </section>
  )
}
