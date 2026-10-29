import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { app } from "electron"
import { previewAuthoringSource } from "../../src/main/mods/devtools/authoring-preview"
import { createAuthoringPreviewBackend } from "../../src/main/mods/devtools/authoring-preview-backend"
import type { AuthoringPreviewAnalysis } from "../../src/main/mods/devtools/authoring-preflight"
import { FunctionSession } from "../../src/main/mods/v2/session"
import {
  AUTHORING_TEMPLATE_KINDS,
  createAuthoringTemplate
} from "../../src/main/mods/devtools/authoring-templates"

app.setPath("userData", tmpdir())
void app
  .whenReady()
  .then(async () => {
    for (const kind of AUTHORING_TEMPLATE_KINDS) {
      const source = createAuthoringTemplate({
        kind,
        id: "real-preview",
        name: "real preview",
        instruction: "actual utility process"
      })
      let compiled: AuthoringPreviewAnalysis["compiled"] | undefined
      const action =
        kind === "capability"
          ? { kind: "inspect", target: "", input: "" }
          : kind === "tool"
          ? { kind: "tool", target: "mcp__real-preview__format", input: '{"text":"real"}' }
          : kind === "rule"
            ? { kind: "rule", target: "", input: "real" }
            : { kind: "command", target: "real-preview", input: "real" }
      const report = await previewAuthoringSource(source, action, {
        backend: () => {
          const backend = createAuthoringPreviewBackend()
          return { ...backend, preflight: async (directory, signal) => {
            const analysis = await backend.preflight(directory, signal)
            compiled = analysis.compiled
            return analysis
          } }
        },
        assertCurrent: () => {},
        signal: new AbortController().signal
      })
      assert.equal(report.failures, 0)
      assert.equal(report.authorized, false)
      assert.equal(report.sourceDigest, source.digest)
      assert.equal(report.typecheck.valid, true)
      assert.equal(report.typecheck.digest, report.compiledDigest)
      if (kind === "capability") {
        assert.deepEqual(report.commands, [])
        assert.equal(report.result, null)
        assert(report.compatibility.registrations.some(row => row.pattern === "platform.action"))
        assert(compiled)
        // Inspect does not authorize invocation. This separate test-owned session runs
        // the same Worker-compiled source in a fresh real utility process, without an install.
        const backend = createAuthoringPreviewBackend()
        const guest = await backend.load(compiled.code, compiled.options)
        const plugin = { name: compiled.name, root: tmpdir(), tier: "user" as const,
          guest, modelProtocol: compiled.modelProtocol, capabilities: ["platform.act"] }
        const session = new FunctionSession([plugin], { workspace: tmpdir(),
          threadId: "isolated-public-provider", assertLive: () => {}, publish: async value => value })
        try {
          const request = { ref: { provider: compiled.name, id: "real-preview", version: "1.0.0" },
            target: { kind: "current" as const }, action: "run",
            input: { text: "actual utility public action" }, requestKey: "public-positive" }
          assert.deepEqual(await session.platform.act(plugin, request, new AbortController().signal), {
            status: "succeeded", requestKey: "public-positive", value: { text: "actual utility public action" }
          })
          await assert.rejects(session.platform.act(plugin,
            { ...request, input: {}, requestKey: "public-invalid" }, new AbortController().signal),
          /MODS_REGISTERED_TOOL_INPUT/)
          console.log("PASS actual utility public capability: exact result and invalid-input refusal")
        } finally {
          try { await session.close(true) } finally { await backend.stop() }
        }
      } else assert.match(
        JSON.stringify(kind === "panel" ? report.panes : report.result),
        /actual utility process/
      )
      console.log(`PASS actual worker and utility preview: ${kind}`)
    }
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
