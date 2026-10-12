const key = "cmb.skill-import.pending.v1"
type StoragePort = Pick<Storage, "getItem" | "setItem">
function read(storage: StoragePort): Record<string, string> {
  const raw = storage.getItem(key)
  if (!raw || raw.length > 16_384) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([sha, id]) =>
            /^[a-f0-9]{64}$/.test(sha) && typeof id === "string" && /^[a-f0-9-]{36}$/.test(id)
        )
        .slice(0, 64)
    )
  } catch {
    return {}
  }
}

/** Only hashes and operation IDs persist, never file contents or source URLs.
 * Keep an unacknowledged install identity across a renderer/app restart. */
export function rememberSkillImport(
  sha: string,
  candidate: string,
  storage: StoragePort = localStorage
): string {
  const pending = read(storage)
  if (pending[sha]) return pending[sha]
  if (Object.keys(pending).length >= 64)
    throw new Error("有较多导入尚未确认，请先重试并核对之前的技能")
  storage.setItem(key, JSON.stringify({ ...pending, [sha]: candidate }))
  return candidate
}

export function acknowledgeSkillImport(
  sha: string,
  id: string,
  storage: StoragePort = localStorage
): void {
  const pending = read(storage)
  if (pending[sha] !== id) return
  delete pending[sha]
  storage.setItem(key, JSON.stringify(pending))
}
