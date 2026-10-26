import { readPackageExtensionContract } from "../../plugins/extension-contract"
import { parseRetainedAgentProfile } from "../../agent/agent-registry"
import {
  readRuntimeScopedFile,
  runtimeDigest,
  runtimeDirectory,
  runtimeDirectoryIdentity
} from "./safe-files"
import type { RuntimeExecutionResources } from "../../plugins/runtime-source-scope"

/** Host-issued resources only; paths never come from guest workflow arguments. */
export function readRetainedExecutionResources(
  root: string,
  directory: (binding: string) => string
): RuntimeExecutionResources | undefined {
  const declaration = readPackageExtensionContract(root)?.executionResources
  if (!declaration) return undefined
  const sourceFacts: unknown[] = []
  const profiles = declaration.profiles.map((path) => {
    const file = readRuntimeScopedFile(root, path, 64 * 1024)
    if (!file.bytes?.length) throw Error("PROJECT_EXECUTION_PROFILE_MISSING")
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    if (text.includes("\0")) throw Error("PROJECT_EXECUTION_PROFILE_INVALID")
    sourceFacts.push([path, file.fingerprint])
    return parseRetainedAgentProfile(path, text)
  })
  if (new Set(profiles.map((profile) => profile.name.toLowerCase())).size !== profiles.length)
    throw Error("PROJECT_EXECUTION_PROFILE_DUPLICATE")
  const workspaces = declaration.workspaces.map(({ id, binding }) => {
    const path = runtimeDirectory(directory(binding))
    sourceFacts.push([id, binding, path, runtimeDirectoryIdentity(path)])
    return { id, path }
  })
  return { profiles, workspaces, fingerprint: runtimeDigest(JSON.stringify(sourceFacts)) }
}
