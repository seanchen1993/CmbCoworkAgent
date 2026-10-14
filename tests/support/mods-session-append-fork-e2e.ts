import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

/** Original preload fork IPC, installed SDK source, native Savers and real next HTTP requests. */
export async function verifySessionAppendFork(
  page: Page,
  workspace: string,
  databasePath: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "session-append-fork-project")
  mkdirSync(project, { recursive: true })
  const markers = {
    seed: "FORK_APPEND_ORIGINAL_CONSUMED_NOTE",
    pending: "FORK_APPEND_SOURCE_PENDING_NOTE",
    target: "FORK_APPEND_TARGET_ONLY_NOTE"
  }
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const labels: string[] = []
  const evidence: Record<string, unknown> = {
    requests,
    labels,
    complete: false,
    scope:
      "Actual main SDK notes and stable-checkpoint fork; original Plugin/child recovery and missing historical projections are separate"
  }
  const record = (label: string) => {
    labels.push(label)
    pass(label)
  }
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST")
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      assert(Array.isArray(body.messages))
      requests.push(body)
      response.writeHead(200, { "content-type": "text/event-stream" })
      const frame = (choices: unknown[], usage?: Record<string, number>) =>
        response.write(
          `data: ${JSON.stringify({
            id: `fork-append-${requests.length}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4",
            choices,
            ...(usage ? { usage } : {})
          })}\n\n`
        )
      frame([
        {
          index: 0,
          delta: { role: "assistant", content: `FORK_APPEND_CHAT_OK_${requests.length}` },
          finish_reason: "stop"
        }
      ])
      frame([], { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
      response.end("data: [DONE]\n\n")
    } catch (error) {
      evidence.providerError = String(error)
      if (!response.headersSent) response.writeHead(500)
      response.end("Actual fork fixture failed")
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}/v1`
  try {
    const sourceId = await page.evaluate(
      async ({ project, base }) => {
        await window.api.models.setCustomConfig({
          id: "fork-append-local",
          name: "Fork append local",
          baseUrl: base,
          model: "gpt-4",
          apiKey: "local-fixture-key",
          maxTokens: 32000,
          maxOutputTokens: 512
        })
        await window.api.models.setDefault("custom:fork-append-local")
        const thread = await window.api.threads.create({
          title: "Fork append original",
          workspacePath: project,
          agentMode: "normal"
        })
        const id = (thread as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, project)
        await window.api.threads.patchMetadata(id, {
          set: { model: "custom:fork-append-local", subagentsEnabled: false }
        })
        await window.api.mods.configure(id, true, true)
        return id
      },
      { project, base }
    )
    evidence.sourceId = sourceId
    const source = `export function register(on){
      on("session.start",async($,e,next)=>{
        for(const name of ["fork-seed","fork-pending","fork-target"])
          await $.command.register({name,description:name,immediate:true});return next(e);
      });
      ${Object.entries(markers)
        .map(
          ([name, text]) => `
      on("command.run",{command:"fork-${name}"},async($)=>({text:JSON.stringify(
        await $.session.append({message:{type:"user",content:[{type:"text",text:"${text}"}]}})
      )}));`
        )
        .join("\n")}
    }`
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(JSON.stringify({ name: "session-append-fork", version: "1.0.0" }))
    )
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
    zip.addFile("hooks/register.ts", Buffer.from(source))
    const bytes = zip.toBuffer()
    writeFileSync(join(artifacts, "session-append-fork.zip"), bytes)
    const installed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "session-append-fork.zip",
          "local"
        ),
      [...bytes]
    )
    assert(installed.success, installed.error)
    const approve = async (id: string) => {
      await page.evaluate((id) => window.api.mods.configure(id, true, true), id)
      const row = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods?.find(
        (row) => row.name === "session-append-fork"
      )
      assert(row?.digest)
      await page.evaluate(
        ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
        { id, pluginId: row.pluginId, digest: row.digest }
      )
    }
    await approve(sourceId)
    const run = async (id: string, command: string): Promise<{ uuid: string }> => {
      const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), id)).find(
        (value) => value.command === command
      )
      assert(descriptor, `Actual command missing: ${command}`)
      const job = await page.evaluate(
        ({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "" }),
        { id, descriptor }
      )
      await until(
        async () =>
          (await page.evaluate((id) => window.api.mods.jobs(id), id)).some(
            (value) => value.id === job.id && !["queued", "running"].includes(value.state)
          ),
        command
      )
      const settled = (await page.evaluate((id) => window.api.mods.jobs(id), id)).find(
        (value) => value.id === job.id
      )
      assert.equal(settled?.state, "succeeded", JSON.stringify(settled))
      const result = JSON.parse(settled?.result?.text ?? "null")
      assert(typeof result?.uuid === "string")
      return result
    }
    const saved = (id: string) => page.evaluate((id) => window.api.threads.getMessages(id), id)
    const open = async (title: string) => {
      await page.reload({ waitUntil: "domcontentloaded" })
      await page.getByText(title, { exact: true }).first().click()
    }
    const send = async (id: string, text: string, number: number) => {
      const composer = page.locator("textarea.composer-textarea")
      await composer.fill(text)
      await composer.press("Enter")
      await until(
        async () =>
          requests.length === number &&
          JSON.stringify(await saved(id)).includes(`FORK_APPEND_CHAT_OK_${number}`) &&
          (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
        `real native fork turn ${number}`
      )
    }
    const seed = await run(sourceId, "fork-seed")
    assert.equal(requests.length, 0)
    await open("Fork append original")
    await send(sourceId, "FORK_APPEND_FIRST_USER", 1)
    const pending = await run(sourceId, "fork-pending")
    const beforeSource = await saved(sourceId)
    const fork = await page.evaluate(
      (id) => window.api.threads.fork({ sourceThreadId: id, title: "Fork append copied" }),
      sourceId
    )
    const targetId = (fork.thread as unknown as { thread_id: string }).thread_id
    assert(targetId && targetId !== sourceId)
    evidence.targetId = targetId
    const copied = await saved(targetId)
    const originalSeed = beforeSource.find((row) => row.id === seed.uuid)
    const targetSeed = copied.find((row) => row.id === seed.uuid)
    assert(originalSeed?.function_row && targetSeed?.function_row)
    assert.notEqual(
      targetSeed.function_row.conversationId,
      originalSeed.function_row.conversationId
    )
    assert.deepEqual(targetSeed.content, originalSeed.content)
    assert(!copied.some((row) => row.id === pending.uuid))
    assert(copied.some((row) => JSON.stringify(row.content).includes("FORK_APPEND_CHAT_OK_1")))
    assert.deepEqual(await saved(sourceId), beforeSource)
    assert.equal(requests.length, 1)
    record(
      "original fork IPC copies the actual completed transcript into a fresh conversation and leaves source pending notes untouched without model replay"
    )
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const journal = db
        .prepare(
          "SELECT status,target_thread_id FROM function_conversation_fork_imports WHERE target_thread_id=?"
        )
        .get(targetId)
      assert.equal(journal?.status, "ready")
      const rows = db
        .prepare(
          `SELECT conversation_id,receipt_id,native_payload_digest,projection_json
        FROM function_conversation_projection_receipts p JOIN function_conversation_rows r
        ON r.receipt_id=p.canonical_receipt_id WHERE p.thread_id IN (?,?) AND p.uuid=?`
        )
        .all(sourceId, targetId, seed.uuid)
      assert.equal(rows.length, 2)
      assert.notEqual(rows[0].receipt_id, rows[1].receipt_id)
      assert.equal(rows[0].native_payload_digest, rows[1].native_payload_digest)
      evidence.copiedReceipts = rows
      const sourceConversation = originalSeed.function_row.conversationId
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM function_conversation_inbox WHERE conversation_id=? AND uuid=?"
          )
          .get(sourceConversation, pending.uuid)?.n,
        1
      )
      assert.equal(
        db
          .prepare("SELECT COUNT(*) AS n FROM function_conversation_inbox WHERE conversation_id=?")
          .get(targetSeed.function_row.conversationId)?.n,
        0
      )
    } finally {
      db.close()
    }
    record(
      "actual app database contains fresh canonical/projection receipts and ready native checkpoint evidence, with no copied pending inbox"
    )
    await approve(targetId)
    const targetOnly = await run(targetId, "fork-target")
    await open("Fork append copied")
    await send(targetId, "FORK_APPEND_TARGET_USER", 2)
    for (const marker of [markers.seed, markers.target])
      assert.equal(
        requests[1].messages.filter((value) => JSON.stringify(value.content).includes(marker))
          .length,
        1
      )
    assert(!JSON.stringify(requests[1]).includes(markers.pending))
    record(
      "next real copied-session HTTP uses its restored native checkpoint and new target note once, without importing source pending notes"
    )
    await open("Fork append original")
    await send(sourceId, "FORK_APPEND_SOURCE_USER", 3)
    for (const marker of [markers.seed, markers.pending])
      assert.equal(
        requests[2].messages.filter((value) => JSON.stringify(value.content).includes(marker))
          .length,
        1
      )
    assert(!JSON.stringify(requests[2]).includes(markers.target))
    assert(!(await saved(sourceId)).some((row) => row.id === targetOnly.uuid))
    record(
      "original session still consumes its own pending note once and remains independent after copied-session execution"
    )
    const legacyProject = join(workspace, "ordinary-fork-project")
    mkdirSync(legacyProject)
    const ordinaryId = await page.evaluate(async (project) => {
      const thread = await window.api.threads.create({
        title: "Ordinary fork original",
        workspacePath: project,
        agentMode: "normal"
      })
      const id = (thread as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, project)
      await window.api.threads.patchMetadata(id, {
        set: { model: "custom:fork-append-local", subagentsEnabled: false }
      })
      await window.api.mods.configure(id, false, false)
      return id
    }, legacyProject)
    await open("Ordinary fork original")
    await send(ordinaryId, "FORK_APPEND_ORDINARY_USER", 4)
    const ordinaryFork = await page.evaluate(
      (id) => window.api.threads.fork({ sourceThreadId: id, title: "Ordinary fork copied" }),
      ordinaryId
    )
    const ordinaryTargetId = (ordinaryFork.thread as unknown as { thread_id: string }).thread_id
    assert(ordinaryTargetId && ordinaryTargetId !== ordinaryId)
    assert(JSON.stringify(await saved(ordinaryTargetId)).includes("FORK_APPEND_CHAT_OK_4"))
    const legacyDb = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(
        legacyDb
          .prepare("SELECT COUNT(*) AS n FROM function_logical_sessions WHERE thread_id IN (?,?)")
          .get(ordinaryId, ordinaryTargetId)?.n,
        0
      )
    } finally {
      legacyDb.close()
    }
    await open("Ordinary fork copied")
    await send(ordinaryTargetId, "FORK_APPEND_ORDINARY_TARGET_USER", 5)
    assert(JSON.stringify(requests[4]).includes("FORK_APPEND_ORDINARY_USER"))
    assert(JSON.stringify(requests[4]).includes("FORK_APPEND_CHAT_OK_4"))
    assert(!JSON.stringify(requests[4]).includes(markers.seed))
    record(
      "existing ordinary chat and fork still restore and continue through real HTTP with Mods off and no conversation-family migration"
    )
    const captureFamily = (id: string) => {
      const database = new DatabaseSync(databasePath, { readOnly: true })
      try {
        const sessions = database
          .prepare("SELECT logical_session_id FROM function_logical_sessions WHERE thread_id=?")
          .all(id)
        const conversations = sessions.flatMap((session) =>
          database
            .prepare(
              "SELECT conversation_id FROM function_conversations WHERE logical_session_id=?"
            )
            .all(session.logical_session_id)
        )
        const receipts = conversations.flatMap((conversation) =>
          database
            .prepare(
              "SELECT receipt_id FROM function_conversation_checkpoint_receipts WHERE conversation_id=?"
            )
            .all(conversation.conversation_id)
        )
        return { sessions, conversations, receipts }
      } finally {
        database.close()
      }
    }
    const assertFamilyDeleted = (id: string, family: ReturnType<typeof captureFamily>) => {
      const database = new DatabaseSync(databasePath, { readOnly: true })
      try {
        assert.equal(
          database.prepare("SELECT COUNT(*) AS n FROM threads WHERE thread_id=?").get(id)?.n,
          0
        )
        assert.equal(
          database.prepare("SELECT COUNT(*) AS n FROM thread_messages WHERE thread_id=?").get(id)
            ?.n,
          0
        )
        assert.equal(
          database
            .prepare("SELECT COUNT(*) AS n FROM function_logical_sessions WHERE thread_id=?")
            .get(id)?.n,
          0
        )
        assert.equal(
          database
            .prepare(
              "SELECT COUNT(*) AS n FROM function_conversation_projection_receipts WHERE thread_id=?"
            )
            .get(id)?.n,
          0
        )
        for (const conversation of family.conversations) {
          for (const table of [
            "function_conversations",
            "function_conversation_branches",
            "function_conversation_rows",
            "function_conversation_inbox",
            "function_conversation_deliveries",
            "function_conversation_checkpoint_receipts"
          ]) {
            assert.equal(
              database
                .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE conversation_id=?`)
                .get(conversation.conversation_id)?.n,
              0,
              `${id}: ${table}`
            )
          }
        }
        for (const receipt of family.receipts)
          assert.equal(
            database
              .prepare(
                "SELECT COUNT(*) AS n FROM function_conversation_checkpoint_members WHERE receipt_id=?"
              )
              .get(receipt.receipt_id)?.n,
            0
          )
      } finally {
        database.close()
      }
    }
    const sourceFamily = captureFamily(sourceId)
    const beforeSourceDeletion = await saved(targetId)
    await page.evaluate((id) => window.api.threads.delete(id), sourceId)
    assertFamilyDeleted(sourceId, sourceFamily)
    assert.deepEqual(await saved(targetId), beforeSourceDeletion)
    const survivingDb = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(
        survivingDb
          .prepare("SELECT status FROM function_conversation_fork_imports WHERE target_thread_id=?")
          .get(targetId)?.status,
        "ready"
      )
    } finally {
      survivingDb.close()
    }
    await open("Fork append copied")
    await send(targetId, "FORK_APPEND_AFTER_SOURCE_DELETE", 6)
    assert(JSON.stringify(requests[5]).includes(markers.seed))
    assert(JSON.stringify(requests[5]).includes(markers.target))
    assert(!JSON.stringify(requests[5]).includes(markers.pending))
    record(
      "original delete IPC removes the source family and receipts while its independent fork preserves history and completes its next real HTTP turn"
    )
    const targetFamily = captureFamily(targetId)
    await page.evaluate((id) => window.api.threads.delete(id), targetId)
    assertFamilyDeleted(targetId, targetFamily)
    const deletedDb = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(
        deletedDb
          .prepare(
            "SELECT COUNT(*) AS n FROM function_conversation_fork_imports WHERE target_thread_id=?"
          )
          .get(targetId)?.n,
        0
      )
      assert(JSON.stringify(await saved(ordinaryTargetId)).includes("FORK_APPEND_CHAT_OK_5"))
    } finally {
      deletedDb.close()
    }
    evidence.deletedFamilies = { source: sourceFamily, target: targetFamily }
    record(
      "deleting the copied session through the original IPC clears its own canonical family, projections, checkpoint members and fork journal while an ordinary session remains intact"
    )
    await page.screenshot({ path: join(artifacts, "session-append-fork-final.png") })
    evidence.complete = true
  } catch (error) {
    evidence.error =
      error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    throw error
  } finally {
    writeFileSync(
      join(artifacts, "session-append-fork-evidence.json"),
      JSON.stringify(evidence, null, 2)
    )
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
