import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { app } from "electron"
import { previewAuthoringSource } from "../../src/main/mods/devtools/authoring-preview"
import { createAuthoringPreviewBackend } from "../../src/main/mods/devtools/authoring-preview-backend"
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
      const action =
        kind === "tool"
          ? { kind: "tool", target: "mcp__real-preview__format", input: '{"text":"real"}' }
          : kind === "rule"
            ? { kind: "rule", target: "", input: "real" }
            : { kind: "command", target: "real-preview", input: "real" }
      const report = await previewAuthoringSource(source, action, {
        backend: createAuthoringPreviewBackend,
        assertCurrent: () => {},
        signal: new AbortController().signal
      })
      assert.equal(report.failures, 0)
      assert.equal(report.authorized, false)
      assert.equal(report.sourceDigest, source.digest)
      assert.equal(report.typecheck.valid, true)
      assert.equal(report.typecheck.digest, report.compiledDigest)
      assert.match(
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
