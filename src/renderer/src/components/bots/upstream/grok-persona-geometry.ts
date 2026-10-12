import { PERSONA_REST_CONTOURS } from "./grok-persona-rest-contours"
// Preserve the 0.18 identity mapping; resting contours use the verified 0.66 renderer assets.
export const VIEWBOX = "-15 -15 259 259"
export const CENTER = 114.2705
export const COLORS: Record<string, { light: string; dark: string }> = {
  black: { light: "#000000", dark: "#FFFFFF" },
  brown: { light: "#A27952", dark: "#855C36" },
  red: { light: "#FF3E51", dark: "#E02135" },
  orange: { light: "#FF781C", dark: "#FF6700" },
  yellow: { light: "#FFAF38", dark: "#FF9800" },
  green: { light: "#00C972", dark: "#009957" },
  cyan: { light: "#1CC3B0", dark: "#00A592" },
  blue: { light: "#2A92FE", dark: "#0E74E0" },
  violet: { light: "#A97EFE", dark: "#804EE0" },
  magenta: { light: "#FF5EB1", dark: "#E02A88" },
  gray: { light: "#959595", dark: "#777777" }
}

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=1412620
// Eee/Cee's deterministic fallback selectors, kept artifact-exact.
const SHIPPED_SHAPES = [
  "blob",
  "pebble",
  "squircle",
  "tablet",
  "wedge",
  "hex",
  "cloud",
  "teardrop"
] as const
function shippedRandom(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (value + 1831565813) | 0
    let next = Math.imul(value ^ (value >>> 15), 1 | value)
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}
function shippedHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1)
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return hash >>> 0
}
function shippedColorIndex(value: string): number {
  const seed = (shippedHash(value) ^ Math.imul(1, 2654435769)) >>> 0
  return Math.floor(shippedRandom((seed ^ 2654435769) >>> 0)() * 10)
}
function shippedShapeHash(value: string): number {
  let hash = shippedHash(value)
  hash = Math.imul(hash ^ (hash >>> 16), 73244475)
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909)
  return (hash ^ (hash >>> 16)) >>> 0
}
export function resolvePersonaColor(agentId: string, color?: string | null): string {
  if (color != null && COLORS[color] != null) return color
  return (
    ["brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"][
      shippedColorIndex(agentId)
    ] ?? "gray"
  )
}
export function resolvePersonaShape(agentId: string, shape?: string | null): string {
  if (shape != null && (SHIPPED_SHAPES as readonly string[]).includes(shape)) return shape
  return SHIPPED_SHAPES[shippedShapeHash(agentId) % SHIPPED_SHAPES.length] ?? "blob"
}

export const personaRestContour = (shape: string) =>
  PERSONA_REST_CONTOURS[shape] ?? PERSONA_REST_CONTOURS.blob
