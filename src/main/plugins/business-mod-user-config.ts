import { parseFunctionUserConfig, type FunctionUserConfig } from "../../shared/mods/v2/user-config"

/** Reject recognized literal credential declarations rather than silently stripping business rules. */
export function assertPortableBusinessBoard(board: Record<string, unknown>): void {
  const visit = (value: unknown, path: string[]) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]))
      return
    }
    if (!value || typeof value !== "object") return
    for (const [key, item] of Object.entries(value)) {
      if (
        /(?:token|secret|password|api[_-]?key|authorization|credential)/i.test(key) &&
        typeof item === "string" &&
        item.trim() &&
        !/^\$\{[^{}]+\}$/.test(item.trim())
      )
        throw Error(`业务配置包含不可发布的凭据声明，请改为安装后绑定：${[...path, key].join(".")}`)
      visit(item, [...path, key])
    }
  }
  visit(board, [])
}

/** Declarations travel with a package; machine paths and secret values must be rebound by its installer. */
export function parsePortableBusinessModUserConfig(value: unknown): FunctionUserConfig | undefined {
  const schema = parseFunctionUserConfig(value)
  for (const [key, field] of Object.entries(schema ?? {})) {
    if (
      field.default !== undefined &&
      field.default !== "" &&
      (field.sensitive || field.type === "directory" || field.type === "file")
    )
      throw Error(`可移植业务 Mod 的敏感或路径配置不能包含默认值：${key}`)
  }
  return schema
}

export function mergeBusinessModUserConfig(schemas: unknown[]): FunctionUserConfig | undefined {
  const merged: FunctionUserConfig = {}
  for (const value of schemas) {
    const schema = parsePortableBusinessModUserConfig(value)
    for (const [key, field] of Object.entries(schema ?? {})) {
      if (Object.hasOwn(merged, key) && JSON.stringify(merged[key]) !== JSON.stringify(field))
        throw Error(`业务 Mods 用户配置声明冲突：${key}`)
      merged[key] = field
    }
  }
  return Object.keys(merged).length ? parseFunctionUserConfig(merged) : undefined
}
