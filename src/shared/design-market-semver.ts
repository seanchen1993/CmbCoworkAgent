export interface ParsedSemVer {
  major: number
  minor: number
  patch: number
}

const STABLE_SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function parseSemVer(raw: unknown): ParsedSemVer | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  const match = STABLE_SEMVER_RE.exec(trimmed)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null
  }
  return { major, minor, patch }
}

export function normalizeSemVer(raw: unknown): string {
  const parsed = parseSemVer(raw)
  if (!parsed) {
    throw new Error("版本号格式无效，请使用稳定版 SemVer（如 v1.2.0 或 1.2.0）")
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`
}

export function formatMarketVersion(raw: unknown): string {
  const parsed = parseSemVer(raw)
  return parsed ? `v${parsed.major}.${parsed.minor}.${parsed.patch}` : String(raw || "")
}

export function compareSemVer(a: string, b: string): number {
  const pa = parseSemVer(a)
  const pb = parseSemVer(b)
  if (!pa || !pb) {
    throw new Error("无法比较无效的 SemVer 版本号")
  }
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1
  return 0
}

export function isHigherSemVer(candidate: string, baseline: string): boolean {
  return compareSemVer(candidate, baseline) > 0
}

export function isSystemVersionCompatible(systemVersion: string, minSystemVersion: string): boolean {
  const sys = parseSemVer(systemVersion)
  const min = parseSemVer(minSystemVersion)
  if (!sys || !min) return false
  if (compareSemVer(systemVersion, minSystemVersion) < 0) return false
  if (min.major === 0) {
    return sys.major === 0 && sys.minor === min.minor
  }
  return sys.major === min.major
}

export function formatCompatibilityRange(minSystemVersion: string): string {
  const min = parseSemVer(minSystemVersion)
  if (!min) return String(minSystemVersion || "")
  const minLabel = `v${min.major}.${min.minor}.${min.patch}`
  const upperLabel = min.major === 0 ? `v0.${min.minor + 1}.0` : `v${min.major + 1}.0.0`
  return `${minLabel} 及以上，低于 ${upperLabel}`
}

export function pickLatestCompatibleVersion<T>(
  items: readonly T[],
  getVersion: (item: T) => string,
  minSystemVersion: string
): T | null {
  const compatible = items.filter((item) =>
    isSystemVersionCompatible(getVersion(item), minSystemVersion)
  )
  if (compatible.length === 0) return null
  return [...compatible].sort((a, b) => compareSemVer(getVersion(b), getVersion(a)))[0] ?? null
}
