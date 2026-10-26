import { createHash } from "node:crypto"
import type { ClawActionDescriptor } from "../../shared/mods/claw-actions"
import { createAuthoringSourceBundle } from "../mods/devtools/authoring-bundle"
import { inspectProjectSource } from "../mods/devtools/project-doctor"
import { PROJECT_ACTION_LOCK_PATH } from "../../shared/project-runtime/action-bindings"
import {
  compileNativeComposition,
  nativeCompositionSchema,
  NATIVE_COMPOSITION_PATH
} from "./native-composition"
import { renameDerivation, type DerivationFile, type DerivationSnapshot } from "./derivation-source"

/** Read-only validation against the current catalog, also used by original check/install owners. */
export function assertNativeCompositionCurrent(
  snapshot: DerivationSnapshot,
  actionCatalog: readonly ClawActionDescriptor[]
): void {
  if (!snapshot.files.some((file) => file.path === NATIVE_COMPOSITION_PATH)) return
  const original = createAuthoringSourceBundle(
    snapshot.files.map((file) => ({
      path: file.path,
      text: new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    }))
  )
  if (!inspectProjectSource(original, [], actionCatalog).report.valid)
    throw Error("PROJECT_DERIVATION_SOURCE_INVALID")
}

/** Recompile only the new package identity; an existing provider lock is never rebound by renaming. */
export function renameNativeComposition(
  snapshot: DerivationSnapshot,
  name: string,
  version: string | undefined,
  actionCatalog: readonly ClawActionDescriptor[]
): DerivationFile[] {
  const native = snapshot.files.find((file) => file.path === NATIVE_COMPOSITION_PATH)
  if (!native) return renameDerivation(snapshot, name, version)
  assertNativeCompositionCurrent(snapshot, actionCatalog)
  const files = renameDerivation(snapshot, name, version)
  const source = nativeCompositionSchema.parse(JSON.parse(native.bytes.toString("utf8")))
  const compiled = compileNativeComposition(
    {
      ...source,
      plugin: {
        ...source.plugin,
        id: name,
        version: version ?? source.plugin.version
      }
    },
    { files: snapshot.files, actionCatalog }
  )
  const lock = snapshot.files.find((file) => file.path === PROJECT_ACTION_LOCK_PATH)
  if (
    !lock ||
    JSON.stringify(JSON.parse(lock.bytes.toString("utf8"))) !== JSON.stringify(compiled.actionLock)
  )
    throw Error("PROJECT_DERIVATION_PROVIDER_CHANGED")
  const replacements = new Map(compiled.files.map((file) => [file.path, file.bytes]))
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
  const renamed = files.map((file) => {
    const bytes = replacements.get(file.path)
    replacements.delete(file.path)
    return bytes ? { ...file, bytes, digest: hash(bytes) } : file
  })
  for (const [path, bytes] of replacements)
    renamed.push({ path, bytes, mode: 0o644, digest: hash(bytes) })
  return renamed
}
