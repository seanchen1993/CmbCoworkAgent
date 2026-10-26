import { lstat, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { readRuntimeScopedFileAsync } from "../../harness-board/project-runtime/safe-files-async"
import { assertOriginalContent, assertOriginalUpload } from "../../services/market-content"
import {
  snapshotDerivationSource,
  derivationContentIdentity,
  type DerivationSnapshot
} from "../../plugins/derivation-source"
import { readAuthoringProjectSource } from "./project-source"
import { nativeCompositionSchema } from "../../plugins/native-composition"

const path = z
  .string()
  .min(1)
  .max(160)
  .refine(
    (value) => /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value),
    "controlled relative directory required"
  )
export const projectSourceSetSchema = z
  .object({
    protocol: z.literal("devclaw.project-source-set/v1"),
    title: z.string().trim().min(1).max(100),
    goal: z.string().trim().min(1).max(8000),
    project: path,
    dependencies: z.array(path).max(8)
  })
  .strict()

/** A user-selected local root is the only path authority. No downloads or installed-source lookup. */
export async function readProjectSourceSet(root: string, guard: () => void) {
  guard()
  const absolute = resolve(root)
  if ((await lstat(absolute)).isSymbolicLink() || (await realpath(absolute)) !== absolute)
    throw Error("PROJECT_SOURCE_SET_ROOT_UNSAFE")
  assertOriginalContent(absolute)
  const file = await readRuntimeScopedFileAsync(absolute, "devclaw.source-set.json", 16000)
  if (!file.bytes) throw Error("PROJECT_SOURCE_SET_DESCRIPTOR_REQUIRED")
  const declaration = projectSourceSetSchema.parse(JSON.parse(file.bytes.toString("utf8")))
  const paths = [declaration.project, ...declaration.dependencies]
  if (
    new Set(paths.map((value) => value.toLowerCase())).size !== paths.length ||
    paths.some((left) => paths.some((right) => left !== right && right.startsWith(left + "/")))
  )
    throw Error("PROJECT_SOURCE_SET_PATH_COLLISION")
  for (const relative of paths) {
    let current = absolute
    for (const part of relative.split("/")) {
      current = join(current, part)
      const stat = await lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(current)) !== current)
        throw Error("PROJECT_SOURCE_SET_PATH_UNSAFE")
    }
    // Do not even read local connection configuration while importing shareable source.
    for (const name of [
      ".mcp.json",
      ".env",
      "credentials.json",
      "auth.json",
      "settings.local.json"
    ]) {
      try {
        await lstat(join(current, name))
        throw Error("PROJECT_SOURCE_SET_LOCAL_CONFIGURATION_FORBIDDEN")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
  }
  const project = await readAuthoringProjectSource(join(absolute, declaration.project))
  const sourceFile = project.bundle.files.find((file) => file.path === "composition/source.json")
  if (!sourceFile) throw Error("PROJECT_SOURCE_SET_NATIVE_SOURCE_REQUIRED")
  const composition = nativeCompositionSchema.parse(JSON.parse(sourceFile.text))
  const dependencies: Array<{
    name: string
    version: string
    description?: string
    mods?: "mods/manifest.json"
    snapshot: DerivationSnapshot
    digest: string
  }> = []
  let totalBytes = 0
  for (const relative of declaration.dependencies) {
    guard()
    const source = join(absolute, relative)
    assertOriginalContent(source)
    const snapshot = await snapshotDerivationSource(source)
    totalBytes += snapshot.totalBytes
    if (totalBytes > 32 * 1024 * 1024) throw Error("SOURCE_SET_TOTAL_LIMIT")
    // Dependencies use normal complete Function Mod packages, including inert Python/data files.
    // Other plugin registrations need their own explicit delivery protocol.
    const metadata = snapshot.files.find((file) => file.path === "plugin.json")
    if (
      !metadata ||
      !snapshot.files.some((file) => file.path === "mods/manifest.json") ||
      snapshot.files.some((file) =>
        /^(?:\.mcp\.json|hooks\/|skills\/|commands\/|agents\/|devclaw\.)/.test(file.path)
      )
    )
      throw Error("PROJECT_SOURCE_SET_FUNCTION_DEPENDENCY_REQUIRED")
    const plugin = z
      .object({
        name: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        description: z.string().optional(),
        mods: z.literal("mods/manifest.json").optional()
      })
      .strict()
      .parse(JSON.parse(metadata.bytes.toString("utf8")))
    for (const file of snapshot.files) assertOriginalUpload(file.bytes, file.path)
    dependencies.push({ ...plugin, snapshot, digest: derivationContentIdentity(snapshot.files) })
  }
  if (new Set(dependencies.map((value) => value.name)).size !== dependencies.length)
    throw Error("PROJECT_SOURCE_SET_DEPENDENCY_AMBIGUOUS")
  guard()
  return { declaration, project, composition, dependencies }
}
