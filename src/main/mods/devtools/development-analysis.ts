import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { readPureFunctionSource } from "./authoring-install-source"
import { AuthoringPreflightClient } from "./authoring-preflight-client"
import { AuthoringCompileError } from "./authoring-compile-diagnostics"

/** Return actionable compiler diagnostics without executing generated modules. */
export async function analyzeDevelopmentSource(
  source: unknown,
  signal: AbortSignal,
  assertCurrent: () => void
) {
  const bundle = readPureFunctionSource(source)
  assertCurrent()
  signal.throwIfAborted()
  const directory = await mkdtemp(join(tmpdir(), "cmb-development-check-"))
  const owned = resolve(directory)
  if (dirname(owned) !== resolve(tmpdir()) || !basename(owned).startsWith("cmb-development-check-"))
    throw Error("DEVELOPMENT_CLEANUP_SCOPE")
  const worker = new AuthoringPreflightClient(join(__dirname, "mods-authoring-preflight.js"))
  try {
    for (const file of bundle.files) {
      signal.throwIfAborted()
      const path = join(directory, file.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, file.text, { flag: "wx", encoding: "utf8" })
    }
    const analysis = await worker.run(
      directory,
      AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    )
    assertCurrent()
    signal.throwIfAborted()
    return {
      digest: bundle.digest,
      valid: analysis.sdk.strictCompatible && analysis.typecheck.valid,
      runtimeVerified: false,
      diagnostics: [...analysis.typecheck.diagnostics, ...analysis.sdk.diagnostics],
      capabilities: [...new Set(analysis.sdk.usages.map((usage) => usage.method))].sort()
    }
  } catch (error) {
    assertCurrent()
    signal.throwIfAborted()
    if (!(error instanceof AuthoringCompileError)) throw error
    return {
      digest: bundle.digest,
      valid: false,
      runtimeVerified: false,
      diagnostics: error.diagnostics,
      capabilities: []
    }
  } finally {
    await worker.stop()
    await rm(owned, { recursive: true, force: true, maxRetries: 3 })
  }
}
