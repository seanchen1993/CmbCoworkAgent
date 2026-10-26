import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { transformSync } from "esbuild"
import { expect, it, vi } from "vitest"
import type { ModObject } from "../../shared/mods/types"
type Reader = (input: ModObject, requestKey: string) => Promise<unknown>
const module = { exports: {} as { createCodeEvidenceReader: (sdk: {
  platform: { read: () => Promise<unknown>; act: (input: unknown) => Promise<unknown> }
}) => Promise<Reader> } }
runInNewContext(transformSync(readFileSync(resolve(
  "resources/native-compositions/autobiz-rules/mods/code-evidence-reader.ts"), "utf8"),
  { loader: "ts", format: "cjs" }).code, { module, exports: module.exports })
it("uses the project evidence action and retains exact run/page selection", async () => {
  const act = vi.fn(async () => ({ status: "succeeded" }))
  const read = await module.exports.createCodeEvidenceReader({ platform: {
    read: async () => ({ value: { status: "ready", projectId: "actual-project" } }), act } })
  await read({ runId: "actual-run", worktreeOffset: 1, limit: 32 }, "original-check")
  expect(act).toHaveBeenCalledExactlyOnceWith({
    ref: { provider: "native.project-runtime", id: "project", version: "1.0.0" },
    target: { kind: "current" }, action: "inspect-workflow-evidence",
    input: { runId: "actual-run", worktreeOffset: 1, limit: 32, stageId: "code" }, requestKey: "original-check"
  })
})
it.each(["PROJECT_RUNTIME_PUBLIC_SCOPE_CHANGED", "PROJECT_RUNTIME_PUBLIC_PLUGIN_UNAVAILABLE", undefined])(
  "does not fall back for a project error %s", async code => {
    const act = vi.fn()
    await expect(module.exports.createCodeEvidenceReader({ platform: {
      read: async () => ({ value: { status: "unavailable", code } }), act
    } })).rejects.toThrow("PROJECT_EVIDENCE_SCOPE_UNAVAILABLE")
    expect(act).not.toHaveBeenCalled()
  }
)
it("keeps explicit unbound standalone callers on their original conversation", async () => {
  const act = vi.fn(async () => ({}))
  const read = await module.exports.createCodeEvidenceReader({ platform: {
    read: async () => ({ value: { status: "unavailable", code: "PROJECT_RUNTIME_PUBLIC_UNBOUND" } }), act } })
  await read({ runId: "original-run" }, "check")
  expect(act).toHaveBeenCalledWith(expect.objectContaining({
    ref: { provider: "native.workflow", id: "runs", version: "1.0.0" }, action: "inspect"
  }))
})
