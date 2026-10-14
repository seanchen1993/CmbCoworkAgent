import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"

function invalidRoute(): never {
  throw Error("工作区 Mods 配置读取失败，消息未发送；当前输入和附件已保留。")
}

/** This response chooses a composer route; it grants no file or runtime authority. */
export function captureComposerMentionRoute(
  value: unknown,
  workspacePath: string
): "defer" | "preview" {
  if (!value || typeof value !== "object") return invalidRoute()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return invalidRoute()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || !keys.includes("workspace") || !keys.includes("enabled"))
    return invalidRoute()
  const workspace = Object.getOwnPropertyDescriptor(value, "workspace")
  const enabled = Object.getOwnPropertyDescriptor(value, "enabled")
  if (
    !workspace ||
    !("value" in workspace) ||
    typeof workspace.value !== "string" ||
    !enabled ||
    !("value" in enabled) ||
    typeof enabled.value !== "boolean"
  )
    return invalidRoute()
  const key = normalizeWorkspacePathKey(workspace.value)
  if (!key || key !== normalizeWorkspacePathKey(workspacePath)) return invalidRoute()
  return enabled.value ? "defer" : "preview"
}
