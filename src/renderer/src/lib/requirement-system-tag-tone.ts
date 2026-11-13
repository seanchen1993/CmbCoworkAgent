const SYSTEM_TAG_TONE_CLASSES = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-orange-500",
  "bg-fuchsia-500",
  "bg-lime-600",
  "bg-teal-500",
  "bg-indigo-500",
  "bg-pink-500"
] as const

export function systemTagToneClass(systemId: string): string {
  let hash = 2166136261
  for (const character of systemId) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return SYSTEM_TAG_TONE_CLASSES[(hash >>> 0) % SYSTEM_TAG_TONE_CLASSES.length]
}
