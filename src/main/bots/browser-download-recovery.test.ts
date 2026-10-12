import { afterEach, expect, it } from "vitest"
import { build } from "esbuild"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createHash, randomUUID } from "node:crypto"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { botBrowserFileReceiver } from "./browser-files"

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it.each(["before", "after", "transfer", "notice"] as const)(
  "recovers browser downloads after killing the process at the %s boundary",
  async (boundary) => {
    const root = await mkdtemp(join(tmpdir(), "bot-download-commit-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const database = join(root, "bots.sqlite"),
      objects = join(root, "objects")
    let activeStore: BotStore | undefined = new BotStore(database)
    cleanup.push(() => activeStore?.close())
    const { bot, conversationId } = activeStore.createBot({ nonce: "bot", name: "Download Bot" })
    const origin = activeStore.send({ nonce: "branch-root", conversationId, text: "Branch root" })
    activeStore.cancel(origin.runIds[0])
    activeStore.close()
    activeStore = undefined
    const guid = randomUUID(),
      entry = join(root, "publication.cjs")
    await build({
      stdin: {
        contents: `
          import { writeSync } from "node:fs";
          import { BotStore } from ${JSON.stringify(resolve("src/main/bots/store.ts"))};
          import { BotArtifacts } from ${JSON.stringify(resolve("src/main/bots/artifacts.ts"))};
          import { botBrowserFileReceiver } from ${JSON.stringify(resolve("src/main/bots/browser-files.ts"))};
          const [database, objects, botId, conversationId, threadRootId, guid, boundary] = process.argv.slice(2);
          const store = new BotStore(database);
          const files = new BotArtifacts(objects, store);
          const hold = () => {writeSync(1,"PUBLICATION_BOUNDARY\\n");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);throw new Error("Parent did not kill publication");};
          const run = store.db.run.bind(store.db);
          store.db.run = (sql, args) => {
            if (boundary === "before" && sql === "INSERT INTO bot_message_files VALUES(?,?)") hold();
            if (boundary === "notice" && sql === "DELETE FROM bot_browser_downloads WHERE guid=?") hold();
            return run(sql,args);
          };
          const receiver = botBrowserFileReceiver({store,files,botId,conversationId,threadRootId});
          if (boundary !== "before") receiver.started(guid);
          if (boundary === "transfer") hold();
          if (boundary === "notice") receiver.failed("文件下载已取消", guid);
          if (boundary === "after") store.browserDownloads.settled = hold;
          receiver
            .complete({guid,bytes:Buffer.from("COMPLETE_FILE_BYTES"),suggestedName:"report.txt"},()=>{})
            .then(hold).catch(error=>{console.error(error);process.exit(1)});
        `,
        resolveDir: process.cwd(),
        sourcefile: "download-publication.ts",
        loader: "ts"
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: entry,
      // Electron built-in: ASAR uses it only under Electron; plain Node selects fs.
      external: ["original-fs"],
      logLevel: "silent"
    })
    const child = spawn(
      process.execPath,
      [entry, database, objects, bot.id, conversationId, origin.messageId, guid, boundary],
      { stdio: ["ignore", "pipe", "pipe"] }
    )
    const exited = once(child, "exit")
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await exited
    })
    let output = "",
      errors = ""
    child.stderr.on("data", (chunk) => {
      errors = (errors + String(chunk)).slice(-4000)
    })
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error("Publication boundary timed out: " + errors)),
        10000
      )
      const finish = () => {
        clearTimeout(timer)
        done()
      }
      child.stdout.on("data", (chunk) => {
        output = (output + String(chunk)).slice(-2000)
        if (output.includes("PUBLICATION_BOUNDARY")) finish()
      })
      child.once("error", (error) => {
        clearTimeout(timer)
        fail(error)
      })
      child.once("exit", () => {
        clearTimeout(timer)
        if (!output.includes("PUBLICATION_BOUNDARY")) fail(new Error(errors))
      })
    })
    child.kill("SIGKILL")
    await exited
    const store = (activeStore = new BotStore(database))
    const branch = () => store.messages(conversationId, undefined, 100, undefined, origin.messageId)
    if (boundary === "transfer" || boundary === "notice") {
      // No graceful close: the process was killed with an active journal, or
      // inside the transaction that writes the failure and removes the journal.
      expect(branch()).toEqual([])
      expect(store.browserDownloads.recoverAtStartup()).toBe(1)
      expect(store.browserDownloads.recoverAtStartup()).toBe(0)
      expect(store.artifacts(conversationId)).toEqual([])
      expect(branch()).toHaveLength(1)
      expect(branch()[0]).toMatchObject({
        sender: "system",
        threadRootId: origin.messageId,
        text: "下载未完成：后台重启，下载已中断，请重新下载",
        attachments: []
      })
      expect(store.messages(conversationId)).toHaveLength(1)
      expect(store.snapshot().runs).toEqual([])
      return
    }
    const expected = boundary === "after" ? 1 : 0
    expect(store.artifacts(conversationId)).toHaveLength(expected)
    expect(branch()).toHaveLength(expected)
    expect(store.events().filter((event) => event.kind === "artifact.ready")).toHaveLength(expected)
    const files = new BotArtifacts(objects, store)
    cleanup.push(() => files.close())
    const contentPath = join(
      objects,
      createHash("sha256").update("COMPLETE_FILE_BYTES").digest("hex")
    )
    // Both interruption windows leave complete bytes on disk. Recovery reclaims
    // only the uncommitted object, never the committed branch attachment.
    await access(contentPath)
    await files.recover()
    expect(store.browserDownloads.recoverAtStartup()).toBe(boundary === "after" ? 1 : 0)
    expect(store.browserDownloads.recoverAtStartup()).toBe(0)
    expect(branch()).toHaveLength(expected)
    if (boundary === "before")
      await expect(access(contentPath)).rejects.toMatchObject({ code: "ENOENT" })
    else
      expect((await files.read(`browser-download:${guid}`)).bytes.toString()).toBe(
        "COMPLETE_FILE_BYTES"
      )
    const receiver = botBrowserFileReceiver({
      store,
      files,
      botId: bot.id,
      conversationId,
      threadRootId: origin.messageId
    })
    const file = { guid, bytes: Buffer.from("COMPLETE_FILE_BYTES"), suggestedName: "report.txt" }
    await receiver.complete(file, () => {})
    await receiver.complete(file, () => {})
    expect(store.artifacts(conversationId)).toHaveLength(1)
    expect(branch()).toHaveLength(1)
    expect(branch()[0].attachments).toEqual([`browser-download:${guid}`])
    expect(branch()[0].threadRootId).toBe(origin.messageId)
    expect(store.messages(conversationId)).toHaveLength(1)
    expect((await files.read(`browser-download:${guid}`)).bytes.toString()).toBe(
      "COMPLETE_FILE_BYTES"
    )
  },
  25000
)
