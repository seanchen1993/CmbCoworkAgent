import { hasAuthoringTextExtension, AUTHORING_BUNDLE_LIMITS } from "./authoring-bundle"

/** Extra text resources admitted by a checked main-process package import, never by model input. */
export function normalizeProjectResourcePaths(
  value: unknown,
  allowDirectoryPrefixes = false
): string[] {
  if (!Array.isArray(value) || value.length > AUTHORING_BUNDLE_LIMITS.files)
    throw Error("PROJECT_RESOURCE_PATH_INVALID")
  const paths: string[] = []
  const seen = new Set<string>()
  for (const path of value) {
    if (
      typeof path !== "string" ||
      !path ||
      path.length > AUTHORING_BUNDLE_LIMITS.pathLength ||
      !/^[A-Za-z0-9._/-]+$/.test(path) ||
      (!allowDirectoryPrefixes && !hasAuthoringTextExtension(path)) ||
      path
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part.endsWith(".") ||
            /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) ||
            /^(?:\.git|\.svn|\.hg|node_modules|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|auth\.json|settings\.local\.json|\.ssh|\.aws|\.azure|\.npmrc|\.pypirc|\.netrc)$/i.test(
              part
            )
        )
    )
      throw Error("PROJECT_RESOURCE_PATH_INVALID")
    if (seen.has(path.toLowerCase())) throw Error("PROJECT_RESOURCE_PATH_INVALID")
    seen.add(path.toLowerCase())
    paths.push(path)
  }
  return paths.sort()
}
