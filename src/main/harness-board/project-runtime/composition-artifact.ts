import type { CompositionRun } from "../../../shared/project-runtime/composition-api"
import { readRuntimeScopedFile, runtimeDigest } from "./safe-files"

/** Display only verified artifacts; never execute a file or trust a renderer-supplied path. */
export function readCompositionArtifact(
  run: CompositionRun,
  unitId: string,
  artifactId: string,
  unitWorkspace: (runId: string, unitId: string) => string | undefined
) {
  const unit = run.units.find((unit) => unit.id === unitId)
  const artifact = unit?.proof?.artifacts.find((artifact) => artifact.id === artifactId)
  const declared = run.definition.units
    .find((unit) => unit.id === unitId)
    ?.outputs.find((output) => output.id === artifactId)
  if (unit?.status !== "succeeded" || !artifact || declared?.path !== artifact.path)
    throw Error("COMPOSITION_ARTIFACT_UNVERIFIED")
  const workspace = unitWorkspace(run.id, unitId)
  if (!workspace) throw Error("COMPOSITION_ARTIFACT_UNAVAILABLE")
  const file = readRuntimeScopedFile(workspace, artifact.path, 8 * 1024 * 1024)
  if (!file.bytes || runtimeDigest(file.bytes) !== artifact.digest)
    throw Error("COMPOSITION_ARTIFACT_CHANGED")
  const result = { title: artifactId, path: artifact.path }
  if (file.bytes.length > 256 * 1024)
    return { ...result, content: null, message: "此文件较大，暂不支持直接预览。" }
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    if (content.includes("\0")) throw Error("binary")
    return { ...result, content }
  } catch {
    return { ...result, content: null, message: "此格式暂不支持文字预览。" }
  }
}
