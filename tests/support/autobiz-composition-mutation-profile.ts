/** Reuse an authored candidate's original installation identities, without recompilation. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import type { compileNativeComposition } from "../../src/main/plugins/native-composition"
import { projectCompositionEnvironment } from "./project-composition-e2e-fixtures"
import { sha256 } from "./autobiz-composition-mutation-fixture"

type ExecutableCandidate = Pick<
  ReturnType<typeof compileNativeComposition>,
  "files" | "lock" | "runtime" | "actionLock"
>

export function mutationRuntimeProfile(root: string, originalProfile?: string, resumeWorkspace?: string) {
  const fixture = projectCompositionEnvironment(root)
  if (!originalProfile)
    return { fixture, artifacts: fixture.isolated, priorEvidenceSha256: undefined }
  const profile = resolve(originalProfile)
  assert(
    /^run-[A-Za-z0-9]+$/.test(profile.split(/[\\/]/).at(-1)!),
    "Exact isolated author profile required"
  )
  const priorEvidenceSha256 = sha256(readFileSync(join(profile, "evidence.json")))
  for (const folder of ["data", "electron", "home", "appdata", "localappdata", "temp"])
    assert(existsSync(join(profile, folder)), `Retain original profile ${folder}`)
  for (const [key, value] of Object.entries(fixture.env))
    if (value.startsWith(fixture.isolated))
      fixture.env[key] = join(profile, relative(fixture.isolated, value))
  fixture.isolated = profile
  fixture.artifactRoot = dirname(profile)
  const artifacts = mkdtempSync(join(profile, "runtime-autobiz-mutation-"))
  fixture.workspace = resumeWorkspace ? resolve(resumeWorkspace) : join(artifacts, "workspace")
  if (resumeWorkspace) {
    const path = relative(profile, fixture.workspace)
    assert(path && !path.startsWith("..") && !path.includes(":"), "Owned original workspace required")
    assert(existsSync(join(fixture.workspace, ".git")), "Retain original native project repository")
  } else mkdirSync(fixture.workspace)
  return { fixture, artifacts, priorEvidenceSha256 }
}

export function retainedMutationExecutable(directory: string): ExecutableCandidate {
  const files: ExecutableCandidate["files"] = []
  let bytes = 0
  const visit = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const path = join(folder, entry.name)
      assert(!entry.isSymbolicLink(), "Authored candidate must contain ordinary files")
      if (entry.isDirectory()) visit(path)
      else {
        assert(entry.isFile())
        const content = readFileSync(path)
        bytes += content.byteLength
        assert(files.length < 128 && bytes <= 4 * 1024 * 1024, "Bounded authored candidate")
        files.push({ path: relative(directory, path).replaceAll("\\", "/"), bytes: content })
      }
    }
  }
  visit(directory)
  const json = (path: string) => JSON.parse(readFileSync(join(directory, path), "utf8"))
  return {
    files,
    lock: json("composition/lock.json"),
    runtime: json("devclaw.project-runtime.json"),
    actionLock: json("devclaw.project-actions.lock.json")
  }
}
