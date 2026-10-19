import { posix } from "node:path"
import { normalizePluginRelativePath } from "../../plugins/manifest"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import { parseFunctionUserConfigSchema } from "../../../shared/mods/v2/user-config-schema"

/** Structural closure only. Actual Mod compilation and native consent remain separate gates. */
export function assertProjectPackageExtensions(
  plugin: Record<string, unknown>,
  read: (path: string) => string | undefined
) {
  const json = (path: string): Record<string, unknown> => {
    const value = JSON.parse(read(path) ?? "null")
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("PROJECT_EXTENSION_RESOURCE_MISSING")
    return value
  }
  const local = (path: unknown) => {
    if (typeof path !== "string") throw Error("PROJECT_EXTENSION_PATH_INVALID")
    const result = normalizePluginRelativePath(path)
    if (!result || read(result) === undefined) throw Error("PROJECT_EXTENSION_RESOURCE_MISSING")
    return result
  }
  for (const key of ["mods", "hooks", "mcpServers"])
    if (plugin[key] !== undefined && typeof plugin[key] !== "string")
      throw Error("PROJECT_EXTENSION_PATH_INVALID")
  const nativePath =
    plugin.mods !== undefined
      ? local(plugin.mods)
      : read("mods/manifest.json") !== undefined
        ? "mods/manifest.json"
        : undefined
  if (nativePath) {
    const native = json(nativePath)
    if (native.apiVersion !== "cmb.mods/v2") throw Error("PROJECT_MODS_PROTOCOL_UNSUPPORTED")
    if (typeof native.id !== "string" || !/^[a-zA-Z0-9][\w.-]{0,99}$/.test(native.id))
      throw Error("PROJECT_MODS_ID_INVALID")
    if (native.entry !== undefined) {
      if (typeof native.entry !== "string" || /^(?:[\\/]|[A-Za-z]:)/.test(native.entry))
        throw Error("PROJECT_EXTENSION_PATH_INVALID")
      local(posix.join(posix.dirname(nativePath), native.entry))
    } else if (!native.claw) throw Error("PROJECT_MODS_ENTRY_MISSING")
  }
  const hookPath =
    plugin.hooks !== undefined
      ? local(plugin.hooks)
      : read("hooks/hooks.json") !== undefined
        ? "hooks/hooks.json"
        : undefined
  if (hookPath) {
    // The original plugin Hook reader supports both flat arrays and CC objects. This remains
    // structural closure only; it does not reinterpret handlers or assert their execution.
    const hooks: unknown = JSON.parse(read(hookPath) ?? "null")
    if (!hooks || typeof hooks !== "object")
      throw Error("PROJECT_EXTENSION_RESOURCE_MISSING")
    if (!Array.isArray(hooks) && "modules" in hooks && hooks.modules !== undefined) {
      if (!Array.isArray(hooks.modules) || !hooks.modules.length || hooks.modules.length > 16)
        throw Error("PROJECT_MODS_MODULES_INVALID")
      for (const path of hooks.modules) {
        if (typeof path !== "string" || /^(?:[\\/]|[A-Za-z]:)/.test(path))
          throw Error("PROJECT_EXTENSION_PATH_INVALID")
        local(posix.join(posix.dirname(hookPath), path))
      }
    }
  }
  // The original MCP runtime discovers .mcp.json; never promise another unconsumed path.
  if (plugin.mcpServers !== undefined && plugin.mcpServers !== ".mcp.json")
    throw Error("PROJECT_MCP_PATH_UNSUPPORTED")
  if (plugin.mcpServers !== undefined || read(".mcp.json") !== undefined) {
    const config = json(".mcp.json")
    const servers = config.mcpServers
    if (
      !servers ||
      typeof servers !== "object" ||
      Array.isArray(servers) ||
      Object.keys(servers).length > 16
    )
      throw Error("PROJECT_MCP_CONFIG_INVALID")
    for (const [name, value] of Object.entries(servers)) {
      if (
        !name.trim() ||
        name.length > 128 ||
        name.includes("\0") ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (typeof value.command !== "string" && typeof value.url !== "string")
      )
        throw Error("PROJECT_MCP_CONFIG_INVALID")
      const server = value as Record<string, unknown>
      const text = (item: unknown, maximum: number) =>
        typeof item === "string" && item.length <= maximum && !item.includes("\0")
      const fields = (item: unknown) =>
        item === undefined ||
        (!!item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          Object.keys(item).length <= 128 &&
          Object.entries(item).every(([key, value]) => text(key, 256) && text(value, 65_536)))
      const stdio = typeof server.command === "string"
      if (
        (stdio &&
          (!String(server.command).trim() ||
            !text(server.command, 4096) ||
            server.url !== undefined)) ||
        (!stdio && (!text(server.url, 8192) || !String(server.url).trim())) ||
        (server.args !== undefined &&
          (!Array.isArray(server.args) ||
            server.args.length > 128 ||
            server.args.some((item) => !text(item, 8192)))) ||
        !fields(server.env) ||
        !fields(server.headers) ||
        (server.injectUserHeaders !== undefined && typeof server.injectUserHeaders !== "boolean")
      )
        throw Error("PROJECT_MCP_CONFIG_INVALID")
      if (
        (server.transport !== undefined &&
          (stdio || !["sse", "streamable-http"].includes(String(server.transport)))) ||
        (server.type !== undefined && server.type !== (stdio ? "stdio" : "http"))
      )
        throw Error("PROJECT_MCP_TRANSPORT_UNSUPPORTED")
      if (!stdio) {
        let url: URL
        try {
          url = new URL(String(server.url))
        } catch {
          throw Error("PROJECT_MCP_CONFIG_INVALID")
        }
        if (!["http:", "https:"].includes(url.protocol))
          throw Error("PROJECT_MCP_TRANSPORT_UNSUPPORTED")
      }
    }
  }
  if (plugin.userConfig !== undefined) {
    const schema = parseFunctionUserConfig(plugin.userConfig)
    parseFunctionUserConfigSchema(plugin.userConfigSchema, schema)
  }
}
