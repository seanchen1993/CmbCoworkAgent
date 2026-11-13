/** Two real app versions share only an explicitly created isolated synthetic profile. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import type { Page } from "playwright"
import { startModsModelServer } from "./support/mods-model-server"
import {
  createHeadlessProjectCompositionLaunch,
  existingProjectCompositionEnvironment,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

interface LegacyUpgradeFixture {
  format: "legacy-session-upgrade-v1"
  version: string
  candidate: ReturnType<typeof projectCompositionCandidate>
  threads: Array<{ id: string; prompt: string; checkpointId: string }>
}

async function send(page: Page, threadId: string, prompt: string): Promise<void> {
  const errors = await page.evaluate(
    ({ threadId, prompt }) =>
      new Promise<string[]>((done, fail) => {
        const errors: string[] = []
        const timeout = setTimeout(() => {
          stop()
          fail(Error("LEGACY_UPGRADE_TURN_TIMEOUT"))
        }, 90000)
        const stop = window.api.agent.invoke(
          threadId,
          prompt,
          (event) => {
            if (event.type === "error") errors.push(event.error ?? "unknown error")
            if (event.type === "error" || event.type === "done") {
              clearTimeout(timeout)
              stop()
              done(errors)
            }
          },
          "custom:legacy-upgrade",
          "normal",
          false,
          crypto.randomUUID()
        )
      }),
    { threadId, prompt }
  )
  assert.deepEqual(errors, [], "An upgraded legacy session must remain usable")
}

async function main(): Promise<void> {
  const root = resolve(__dirname, "..")
  const stage = process.env.LEGACY_UPGRADE_STAGE
  assert(stage === "prepare" || stage === "verify", "Explicit prepare/verify stage required")
  const priorPath = process.env.LEGACY_UPGRADE_FIXTURE
  if (stage === "verify") assert(priorPath, "Explicit isolated legacy fixture required")
  const fixture =
    stage === "prepare"
      ? projectCompositionEnvironment(root)
      : (() => {
          const isolated = resolve(priorPath!)
          assert.match(basename(isolated), /^run-[a-zA-Z0-9]{6}$/)
          assert.equal(dirname(isolated), resolve(process.env.COMPOSITION_E2E_ARTIFACT_ROOT!))
          return existingProjectCompositionEnvironment(root, isolated)
        })()
  const preparedPath = join(fixture.isolated, "legacy-upgrade-prepared.json")
  const prior =
    stage === "verify"
      ? (JSON.parse(readFileSync(preparedPath, "utf8")) as LegacyUpgradeFixture)
      : undefined
  if (prior) assert.equal(prior.format, "legacy-session-upgrade-v1")
  const model = await startModsModelServer({ responseIdPrefix: `legacy-${stage}-${randomUUID()}` })
  const checks: string[] = []
  let passed = false
  try {
    const app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    try {
      const version = await app.evaluate(({ app }) => app.getVersion())
      if (stage === "prepare") assert.match(version, /^1\./, "Seed with an actual legacy release")
      else assert.equal(version, "2.0.0")
      const page = await app.firstWindow()
      await page.waitForFunction(() => !!window.api?.threads)
      await page.evaluate(async (baseUrl) => {
        await window.api.models.setCustomConfig({
          id: "legacy-upgrade",
          name: "Local upgrade fixture",
          baseUrl,
          model: "gpt-4",
          apiKey: "local-fixture",
          maxTokens: 32000,
          maxOutputTokens: 512
        })
        await window.api.models.setDefault("custom:legacy-upgrade")
      }, model.url)
      if (stage === "prepare") {
        const threads: LegacyUpgradeFixture["threads"] = []
        for (const name of ["ordinary", "native-migration"]) {
          const id = await page.evaluate(
            async ({ workspace, name }) => {
              const thread = await window.api.threads.create({
                title: `Legacy upgrade ${name}`,
                workspacePath: workspace,
                agentMode: "normal"
              })
              await window.api.workspace.set(thread.thread_id, workspace)
              await window.api.threads.patchMetadata(thread.thread_id, {
                set: { model: "custom:legacy-upgrade", subagentsEnabled: false }
              })
              return thread.thread_id
            },
            { workspace: fixture.workspace, name }
          )
          const prompt = `LEGACY_UPGRADE_HISTORY_${name}`
          await send(page, id, prompt)
          const tuple = (await page.evaluate(
            (id) => window.api.threads.getLatestCheckpoint(id),
            id
          )) as {
            checkpoint?: { id?: string }
          }
          assert(tuple?.checkpoint?.id, "Legacy writer must persist a real checkpoint")
          threads.push({ id, prompt, checkpointId: tuple.checkpoint.id })
        }
        writeFileSync(
          preparedPath,
          JSON.stringify(
            {
              format: "legacy-session-upgrade-v1",
              version,
              candidate: projectCompositionCandidate(root),
              threads
            } satisfies LegacyUpgradeFixture,
            null,
            2
          )
        )
        checks.push("actual legacy package persisted ordinary history and stable checkpoints")
      } else {
        const legacyAnswers = new Map<string, Array<{ id: string; content: string }>>()
        for (const thread of prior!.threads) {
          const history = await page.evaluate(
            (id) =>
              window.api.threads.getMessagesPage(id, {
                limit: 128
              }),
            thread.id
          )
          assert(history.messages.some((message) => message.content === thread.prompt))
          const answers = history.messages
            .filter((message) => message.role === "assistant")
            .map((message) => ({ id: message.id, content: JSON.stringify(message.content) }))
          assert(answers.length > 0, "Legacy release must have persisted an assistant answer")
          legacyAnswers.set(thread.id, answers)
        }
        const assertLegacyAnswers = async (sourceId: string, targetId: string) => {
          const history = await page.evaluate(
            (id) =>
              window.api.threads.getMessagesPage(id, {
                limit: 128
              }),
            targetId
          )
          for (const answer of legacyAnswers.get(sourceId)!)
            assert(
              history.messages.some(
                (message) =>
                  message.id === answer.id && JSON.stringify(message.content) === answer.content
              ),
              "Continuation and fork must preserve the original legacy assistant answer"
            )
        }
        checks.push("upgraded app loaded both legacy histories")
        const ordinary = prior!.threads[0]
        const before = model.requests.length
        await send(page, ordinary.id, "LEGACY_UPGRADE_ORDINARY_CONTINUE")
        await assertLegacyAnswers(ordinary.id, ordinary.id)
        assert(
          model.requests
            .slice(before)
            .some((request) => JSON.stringify(request.messages).includes(ordinary.prompt))
        )
        const fork = await page.evaluate(
          ({ id, checkpointId }) =>
            window.api.threads.fork({
              sourceThreadId: id,
              checkpointId
            }),
          ordinary
        )
        const forkBefore = model.requests.length
        await send(page, fork.thread.thread_id, "LEGACY_UPGRADE_FORK_CONTINUE")
        await assertLegacyAnswers(ordinary.id, fork.thread.thread_id)
        assert(
          model.requests
            .slice(forkBefore)
            .some((request) => JSON.stringify(request.messages).includes(ordinary.prompt)),
          "A historical fork must deliver its legacy history to the model"
        )
        checks.push("ordinary legacy history survived continuation and historical checkpoint fork")
        const native = prior!.threads[1]
        await page.evaluate(async (id) => {
          await window.api.mods.configureGlobal(true)
          await window.api.mods.configure(id, true, true)
          await window.api.mods.installExamples()
          const status = await window.api.mods.status(id)
          const source = status.functionMods?.find((item) => item.name === "function-commands")
          if (!source?.digest) throw Error("LEGACY_UPGRADE_PLUGIN_REQUIRED")
          await window.api.mods.approveFunction(
            id,
            source.pluginId,
            source.digest,
            status.workspace
          )
          await window.api.mods.commands(id)
        }, native.id)
        const nativeBefore = model.requests.length
        await send(page, native.id, "LEGACY_UPGRADE_MODDED_CONTINUE")
        await assertLegacyAnswers(native.id, native.id)
        assert(
          model.requests
            .slice(nativeBefore)
            .some((request) => JSON.stringify(request.messages).includes(native.prompt))
        )
        const nativeFork = await page.evaluate(
          (id) =>
            window.api.threads.fork({
              sourceThreadId: id
            }),
          native.id
        )
        const nativeForkBefore = model.requests.length
        await send(page, nativeFork.thread.thread_id, "LEGACY_UPGRADE_MODDED_FORK_CONTINUE")
        await assertLegacyAnswers(native.id, nativeFork.thread.thread_id)
        assert(
          model.requests
            .slice(nativeForkBefore)
            .some((request) => JSON.stringify(request.messages).includes(native.prompt)),
          "A native-enrolled fork must deliver its legacy history to the model"
        )
        checks.push("legacy native enrollment retained history and forked into a usable session")
      }
      passed = true
    } finally {
      await app.close()
    }
  } finally {
    await model.close()
    writeFileSync(
      join(fixture.isolated, `legacy-upgrade-${stage}.json`),
      JSON.stringify(
        {
          passed,
          stage,
          candidate: projectCompositionCandidate(root),
          checks,
          modelRequests: model.requests.length
        },
        null,
        2
      )
    )
    console.log("Evidence:", fixture.isolated)
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
