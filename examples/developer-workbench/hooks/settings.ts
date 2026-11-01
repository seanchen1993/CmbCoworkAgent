export const defaults = { argv: '["node","--version"]', path: "Main.java", line: "1", column: "1" }

export function settings(value: unknown): typeof defaults {
  const input = value as Record<string, unknown> | null
  const result = { ...defaults }
  for (const key of ["argv", "path", "line", "column"] as const) {
    if (typeof input?.[key] === "string") result[key] = input[key]
  }
  argv(result.argv)
  if (
    !result.path ||
    result.path.length > 512 ||
    result.path.includes("\0") ||
    /[\\:]/.test(result.path) ||
    result.path.startsWith("/") ||
    result.path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw Error("文件路径无效")
  for (const key of ["line", "column"] as const) {
    const n = Number(result[key])
    if (!Number.isSafeInteger(n) || n < 1 || n > 100000) throw Error("行列必须为有效的 1 起始整数")
  }
  return result
}

export function argv(text: string): string[] {
  const value: unknown = JSON.parse(text)
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 16 ||
    value.some((item) => typeof item !== "string" || item.length > 256 || item.includes("\0")) ||
    !String(value[0]).trim() ||
    text.length > 2048
  )
    throw Error("argv 必须为最多 16 项的 JSON 字符串数组")
  return value as string[]
}
