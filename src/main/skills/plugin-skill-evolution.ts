import { isAbsolute, relative, resolve } from "path"

/**
 * True when `targetDir` is the same as, or nested under, `dir`.
 * Mirrors the containment semantics of skills.ts `isPathUnderDir` so the
 * plugin write gate behaves identically to the rest of the skills layer.
 */
function isUnderDir(targetDir: string, dir: string): boolean {
  if (!targetDir || !dir) return false
  const rel = relative(resolve(dir), resolve(targetDir))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * Whether an evolved SKILL may be written in place into `skillDir`.
 *
 * Allowed only when `skillDir` is the same as, or nested under, one of the
 * currently ENABLED plugin skill source directories. This is the security gate
 * that keeps cloud-evolution write-back from escaping into arbitrary paths:
 * the standalone-skill path is custom-dir-only by design, and plugin-owned
 * files must never be writable from anywhere else. Disabled/uninstalled plugins
 * have no source dirs, so their skills are not writable.
 */
export function isPluginSkillWriteAllowed(skillDir: string, pluginSourceDirs: string[]): boolean {
  if (!skillDir) return false
  return pluginSourceDirs.some((dir) => isUnderDir(skillDir, dir))
}
