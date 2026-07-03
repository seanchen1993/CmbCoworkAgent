export function normalizePathKey(path: string | undefined | null): string {
  let normalized = path?.trim().replace(/\\/g, "/").replace(/\/+$/, "") ?? ""
  if (process.platform === "darwin") {
    normalized = normalized.replace(/^\/private\/var\//, "/var/")
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}
