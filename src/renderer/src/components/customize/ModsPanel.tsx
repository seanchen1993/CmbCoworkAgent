import { useCallback, useEffect, useState } from "react"
import type { ModWorkspaceStatus } from "../../../../shared/mods/types"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"
import { ModsAudit } from "./ModsAudit"

export function ModsPanel({ threadId }: { threadId: string | null }): React.JSX.Element {
  const [status, setStatus] = useState<ModWorkspaceStatus | null>(null)
  const [globalEnabled, setGlobalEnabled] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    setGlobalEnabled(await window.api.mods.globalEnabled())
    if (threadId) setStatus(await window.api.mods.status(threadId))
  }, [threadId])
  useEffect(() => {
    let live = true
    setStatus(null)
    setError("")
    window.api.mods.globalEnabled().then(
      (value) => {
        if (live) setGlobalEnabled(value)
      },
      () => {
        if (live) setError("无法读取 Mods 总开关状态。")
      }
    )
    if (threadId)
      window.api.mods.status(threadId).then(
        (value) => {
          if (live) setStatus(value)
        },
        () => {
          if (live) setError("请先为当前会话选择项目目录。")
        }
      )
    return () => {
      live = false
    }
  }, [threadId])
  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setError("")
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
    <section className="border-b p-4 space-y-3 text-sm" data-mods-settings>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">Function Mods</div>
          <p className="text-xs text-muted-foreground">
            这里管理已安装插件提供的函数扩展运行能力。Plugin 负责安装、更新和启停；Function Mods
            负责事件、命令、工具和交互能力。安装插件请进入“插件”，授权后再在这里控制项目级运行状态。
          </p>
        </div>
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
          默认关闭。关闭时不会加载或拦截 Mods 运行时；插件安装、Skills、MCP 配置和普通聊天不受影响。
        </p>
      </div>
      {!threadId && <p className="text-muted-foreground">打开项目会话后配置权限。</p>}
      {error && (
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
