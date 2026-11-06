/** Production Electron IPC/agent/SQLite; only the HTTP model is a local test fixture. */
import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { startModsModelServer } from "./support/mods-model-server"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

async function main() {
  const root = resolve(__dirname, "..")
  const fixture = projectCompositionEnvironment(root)
  const model = await startModsModelServer()
  try {
    const app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    try {
      const page = await app.firstWindow()
      await page.waitForFunction(() => !!window.api?.mods?.development)
      const ids = await page.evaluate(
        async ({ workspace, baseUrl }) => {
          await window.api.models.setCustomConfig({
            id: "retry-local",
            name: "Local fixture",
            baseUrl,
            model: "gpt-4",
            apiKey: "local-fixture-key",
            maxTokens: 32000,
            maxOutputTokens: 512
          })
          await window.api.models.setDefault("custom:retry-local")
          await window.api.mods.configureGlobal(true)
          const targets: string[] = []
          for (const title of ["Creator", "Ordinary"]) {
            const { thread_id: id } = await window.api.threads.create({
              title,
              workspacePath: workspace,
              agentMode: "normal"
            })
            await window.api.workspace.set(id, workspace)
            await window.api.threads.patchMetadata(id, {
              set: { model: "custom:retry-local", subagentsEnabled: false }
            })
            await window.api.mods.configure(id, true, true)
            targets.push(id)
          }
          const [creator, ordinary] = targets
          const scope = await window.api.mods.status(creator)
          await window.api.mods.development.setMode({
            threadId: creator,
            expectedWorkspace: scope.workspace!,
            mode: "creator"
          })
          // Discoverable sources, but none admitted for execution in the ordinary chat.
          await window.api.mods.installExamples()
          return { creator, ordinary }
        },
        { workspace: fixture.workspace, baseUrl: model.url }
      )
      const send = (message: string) =>
        page.evaluate(
          ({ thread, message }) =>
            new Promise<string[]>((resolve, reject) => {
              const errors: string[] = []
              const timer = setTimeout(() => {
                stop()
                reject(Error("Turn did not finish: " + errors.join(", ")))
              }, 90000)
              const stop = window.api.agent.invoke(
                thread,
                message,
                (event) => {
                  if (event.type === "error") errors.push(event.error ?? "unknown error")
                  if (event.type === "done" || event.type === "error") {
                    clearTimeout(timer)
                    stop()
                    resolve(errors)
                  }
                },
                "custom:retry-local",
                "normal",
                false,
                crypto.randomUUID()
              )
            }),
          { thread: ids.ordinary, message }
        )
      assert.deepEqual(await send("ordinary first turn"), [])
      assert(model.requests.length > 0)
      const errors = await send("[mods-stop-failure-task]")
      assert.match(
        errors.join(" "),
        /400|actual protocol request rejected/,
        "expected the provider failure"
      )
      const before = model.requests.length
      assert.deepEqual(await send("ordinary retry succeeds"), [])
      const retry = model.requests
        .slice(before)
        .find((r) => JSON.stringify(r.messages).includes("ordinary retry succeeds"))
      assert(
        retry && JSON.stringify(retry.messages).includes("ordinary first turn"),
        "retry must retain its own history"
      )
      const modes = await page.evaluate(
        async (ids) =>
          Promise.all(
            [ids.creator, ids.ordinary].map(
              async (threadId) => (await window.api.mods.development.status({ threadId })).mode
            )
          ),
        ids
      )
      assert.deepEqual(modes, ["creator", "normal"])
      // The graph schema may name the channel even when unused. Check actual enrollment.
      const db = new DatabaseSync(join(fixture.isolated, "data", "cmbcoworkagent.sqlite"), {
        readOnly: true
      })
      try {
        assert.equal(
          db
            .prepare("SELECT 1 FROM function_logical_sessions WHERE thread_id = ?")
            .get(ids.ordinary),
          undefined,
          "empty selection must not enroll the ordinary thread in Mods history"
        )
      } finally {
        db.close()
      }
      console.log(
        "PASS ordinary chat retained its history across HTTP failure and retry beside a creator chat"
      )
    } finally {
      await app.close()
    }
  } finally {
    await model.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
