import {
  readRuntimeScopedFile,
  runtimeDigest,
  runtimeRelativePath
} from "../../harness-board/project-runtime/safe-files"

export interface PluginStageRecoveryAdapter {
  apiVersion: "devclaw.plugin-stage-recovery/v1"
  entry: string
  runtime: "python"
  isolation: "private-output-copy"
  codeSource: "keep"
  externalEffects: "network-requires-confirmation"
}

/** Reviewed package bytes describe a protocol; they cannot opt out of native isolation. */
export function readPluginStageRecoveryAdapter(root: string) {
  const declaration = readRuntimeScopedFile(root, "devclaw.stage-recovery-adapter.json", 8192)
  if (!declaration.bytes) throw Error("PLUGIN_STAGE_RECOVERY_ADAPTER_REQUIRED")
  const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(declaration.bytes))
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(",") !==
      "apiVersion,codeSource,entry,externalEffects,isolation,runtime" ||
    raw.apiVersion !== "devclaw.plugin-stage-recovery/v1" ||
    raw.runtime !== "python" ||
    raw.isolation !== "private-output-copy" ||
    raw.codeSource !== "keep" ||
    raw.externalEffects !== "network-requires-confirmation" ||
    typeof raw.entry !== "string"
  )
    throw Error("PLUGIN_STAGE_RECOVERY_ADAPTER_INVALID")
  runtimeRelativePath(raw.entry)
  if (!raw.entry.endsWith(".py")) throw Error("PLUGIN_STAGE_RECOVERY_ADAPTER_INVALID")
  const entry = readRuntimeScopedFile(root, raw.entry, 128 * 1024)
  if (!entry.bytes) throw Error("PLUGIN_STAGE_RECOVERY_ADAPTER_REQUIRED")
  return {
    declaration: raw as PluginStageRecoveryAdapter,
    digest: runtimeDigest(Buffer.concat([declaration.bytes, Buffer.from("\0"), entry.bytes])),
    assertCurrent() {
      if (
        readRuntimeScopedFile(root, declaration.path, 8192).fingerprint !==
          declaration.fingerprint ||
        readRuntimeScopedFile(root, entry.path, 128 * 1024).fingerprint !== entry.fingerprint
      )
        throw Error("PLUGIN_STAGE_RECOVERY_ADAPTER_CHANGED")
    }
  }
}
