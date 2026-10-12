/** Production React UI + actual offline checkpoint executor/SQLite worker.
 * Temporary files only; the parent fixture supplies the refresh callback. */
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotSharedWorkspace } from "../src/main/bots/shared-workspace"
import { BotHostLock } from "../src/main/bots/host-lock"
import { BotWorkflowStore } from "../src/main/bots/workflow-store"
import { botWorktreeRecord } from "../src/main/bots/worktree-contract"
import {
  createWorkflowWorktree,
  persistWorkflowWorktreeRecord
} from "../src/main/services/git-worktree"
import {
  executeBotComputerCheckpoint,
  listBotComputerCheckpoints,
  listBotComputerRecoveryCopies,
  deleteBotComputerRecoveryCopy,
  listBotComputerDeliverables,
  resolveBotComputerDeliverables
} from "../src/main/bots/computer-checkpoint-service"
import { BotDomainError } from "../src/shared/bot-types"
import {
  botComputerCheckpointRequest,
  botComputerCheckpointSelection,
  type BotComputerCheckpointRequest
} from "../src/shared/bot-computer-checkpoint"
import type { BotComputerMaintenancePublicProgress } from "../src/shared/bot-computer-maintenance-progress"

async function main() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-computer-ui-")))
  const workspace = await BotSharedWorkspace.open(directory)
  const database = join(directory, "bots.sqlite")
  const store = new BotStore(database, undefined, undefined, workspace.path)
  const bot = store.createBot({ nonce: "browser-checkpoint-owner", name: "Captured owner" })
  store.send({
    nonce: "queued-before-capture",
    conversationId: bot.conversationId,
    text: "Do not replay"
  })
  store.close()
  await writeFile(join(workspace.path, "note.txt"), "captured work")
  await mkdir(join(directory, "browser-profile"))
  await writeFile(join(directory, "browser-profile", "Local State"), "captured profile")
  const renderer = resolve("src/renderer/src"),
    output = resolve("output/bot-computer-checkpoints")
  await mkdir(output, { recursive: true })
  const css = await compile(
    (await readFile(join(renderer, "index.css"), "utf8")).replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => {} }
  )
  const scanner = new Scanner({
    sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
  })
  const bundle = await build({
    stdin: {
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotComputerCheckpoints}from'./src/renderer/src/components/bots/BotComputerCheckpoints';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';
      applyThemePreference('codex-light');window.fixtureTheme=applyThemePreference;window.fixtureClipboard=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>window.fixtureClipboard.push(value)}});
      window.fixtureStorageRemovalFails=false;const removeItem=Storage.prototype.removeItem;Storage.prototype.removeItem=function(key){if(window.fixtureStorageRemovalFails&&key==='cmb:bot-computer-maintenance:pending')throw new Error('storage unavailable');return removeItem.call(this,key)};
      window.fixtureRevealSettled=0;const reveal=async(kind,id)=>{try{return await window.fixtureReveal(kind,id)}finally{window.fixtureRevealSettled++}};window.api={botComputerCheckpoints:{list:()=>window.fixtureList(),recoveryCopies:()=>window.fixtureCopies(),deliverables:()=>window.fixtureDeliverables(),execute:input=>window.fixtureExecute(input),deleteRecovery:input=>window.fixtureDeleteRecovery(input),revealRecovery:id=>reveal('original',id),revealDeliverables:id=>reveal('deliverables',id),progress:()=>window.fixtureProgress()}};
      function Fixture(){const[open,setOpen]=useState(true);const[generation,setGeneration]=useState(0);window.fixtureReopen=()=>{setGeneration(value=>value+1);setOpen(true)};return <main className="min-h-screen bg-background p-8 text-foreground"><button onClick={()=>{setGeneration(value=>value+1);setOpen(true)}}>电脑检查点入口</button>{open&&<BotComputerCheckpoints key={generation} close={()=>setOpen(false)} onRestored={receipt=>window.fixtureRefresh(receipt)}/>}</main>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  page.setDefaultTimeout(15_000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const calls: BotComputerCheckpointRequest[] = [],
    deletionCalls: unknown[] = [],
    revealed: { kind: "original" | "deliverables"; id: string; directory: string }[] = []
  let loseReply = false,
    loseDeletionReply = false,
    failRefresh = false,
    refreshes = 0,
    progressReads = 0
  let publicProgress: BotComputerMaintenancePublicProgress | null = null
  const options = {
    nativeEntry: resolve("src/main/bots/computer-checkpoint-native-entry.ts"),
    nativeExecArgv: ["--import", "tsx"],
    progress: (
      value: import("../src/shared/bot-computer-maintenance-progress").BotComputerMaintenanceProgress
    ) => {
      publicProgress = {
        nonce: value.nonce,
        operation: value.operation,
        phase: value.phase,
        component: value.component,
        activity: value.activity,
        startedAt: value.startedAt,
        updatedAt: value.updatedAt,
        sequence: value.sequence,
        entries: value.entries,
        bytes: value.bytes
      }
    }
  }
  const failure = (cause: unknown) => ({
    botFailure: {
      code: cause instanceof BotDomainError ? cause.code : "fixture_failure",
      message: cause instanceof Error ? cause.message : "Operation failed"
    }
  })
  try {
    await page.exposeFunction("fixtureList", () => listBotComputerCheckpoints(directory))
    await page.exposeFunction("fixtureCopies", () => listBotComputerRecoveryCopies(directory))
    await page.exposeFunction("fixtureDeliverables", () => listBotComputerDeliverables(directory))
    await page.exposeFunction("fixtureProgress", () => {
      progressReads++
      return publicProgress
    })
    await page.exposeFunction("fixtureExecute", async (raw: unknown) => {
      const input = botComputerCheckpointRequest.parse(raw)
      calls.push(input)
      try {
        const result = await executeBotComputerCheckpoint(directory, input, options)
        publicProgress = null
        if (loseReply) {
          loseReply = false
          return failure(new BotDomainError("transport_closed", "回执暂时不可用"))
        }
        return result
      } catch (cause) {
        publicProgress = null
        return failure(cause)
      }
    })
    await page.exposeFunction("fixtureDeleteRecovery", async (raw: unknown) => {
      const input = botComputerCheckpointSelection.parse(raw)
      deletionCalls.push(input)
      try {
        await deleteBotComputerRecoveryCopy(directory, input, options)
        if (loseDeletionReply) {
          loseDeletionReply = false
          return failure(new BotDomainError("transport_closed", "清理回执暂时不可用"))
        }
        return null
      } catch (cause) {
        return failure(cause)
      }
    })
    await page.exposeFunction(
      "fixtureReveal",
      async (kind: "original" | "deliverables", id: string) => {
        // Native shell opening is mocked; the actual executor supplies the two
        // independently existing directories and the durable result list.
        const target =
          kind === "deliverables"
            ? await resolveBotComputerDeliverables(directory, id)
            : join(directory, "computer-recovery", "recovery", id)
        assert.equal(await realpath(target), target)
        revealed.push({ kind, id, directory: target })
        return null
      }
    )
    await page.exposeFunction("fixtureRefresh", () => {
      refreshes++
      if (failRefresh) throw new Error("后台连接暂时不可用")
    })
    await page.route("http://127.0.0.1:39182/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<html><head><style>${css.build(scanner.scan())}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`
      })
    )
    await page.goto("http://127.0.0.1:39182")
    const dialog = page.getByRole("dialog", { name: "电脑检查点", exact: true })
    const waitForNativeReveal = (count: number) =>
      page.waitForFunction(
        (expected) =>
          (window as unknown as { fixtureRevealSettled: number }).fixtureRevealSettled >= expected,
        count
      )
    await dialog.getByText("还没有电脑检查点", { exact: true }).waitFor()
    await dialog.getByText("暂无恢复的代码成果", { exact: true }).waitFor()
    assert.equal(await dialog.getByRole("button", { name: "打开代码成果", exact: true }).count(), 0)
    const idleReads = progressReads
    await page.waitForTimeout(1100)
    assert.equal(progressReads, idleReads, "idle dialog has no progress poller")
    // Capture one real managed repository so the list and buttons never rely
    // on fabricated project counts or an absent deliverables directory.
    const project = join(directory, "source-project"),
      appDataRoot = `${directory}-workspaces`
    await mkdir(project)
    const git = (cwd: string, ...args: string[]) =>
      promisify(execFile)("git", [
        "-c",
        "user.name=Checkpoint UI",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-C",
        cwd,
        ...args
      ])
    await git(project, "init", "-b", "main")
    await writeFile(join(project, "app.txt"), "captured project\n")
    await git(project, "add", "app.txt")
    await git(project, "commit", "-m", "captured project")
    const managedStore = new BotStore(database, undefined, undefined, workspace.path)
    try {
      const parent = managedStore.claim("checkpoint-ui-git", 300_000)!
      const workflow = BotWorkflowStore.open(managedStore, parent.lease, "checkpoint-ui", {
        script:
          'export const meta = { name: "Checkpoint UI", description: "Capture managed work" }; return "ok"',
        maxConcurrency: 1,
        defaultModelId: "test",
        agentProfiles: [],
        authority: {}
      })
      const info = await createWorkflowWorktree({
        workspacePath: project,
        appDataRoot,
        runId: workflow.id,
        threadId: parent.run.id,
        persistOwnership: true
      })
      const { name, ...binding } = info
      const record = botWorktreeRecord.parse({
        ...binding,
        id: name,
        runId: workflow.id,
        threadId: parent.run.id,
        status: "ready",
        dirty: false,
        updatedAt: new Date().toISOString()
      })
      await persistWorkflowWorktreeRecord(record, appDataRoot)
      managedStore.db.run("INSERT INTO bot_worktrees VALUES(?,?,?,?)", [
        parent.run.id,
        workflow.id,
        JSON.stringify(record),
        managedStore.now()
      ])
    } finally {
      managedStore.close()
    }
    loseReply = true
    await dialog.getByRole("button", { name: "保存检查点", exact: true }).click()
    await dialog.getByRole("button", { name: "确认操作", exact: true }).click()
    await dialog.getByText("回执暂时不可用", { exact: true }).waitFor()
    const first = calls[0]
    assert.equal(first.action, "create")
    const pendingKey = "cmb:bot-computer-maintenance:pending"
    assert.deepEqual(
      JSON.parse(await page.evaluate((key) => localStorage.getItem(key)!, pendingKey)),
      first
    )
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()
    await page.getByRole("button", { name: "电脑检查点入口", exact: true }).click()
    await dialog.getByRole("button", { name: "核对原请求", exact: true }).click()
    await dialog.getByText("电脑检查点已保存", { exact: true }).waitFor()
    assert.deepEqual(calls[1], first)
    assert.equal(
      (await listBotComputerCheckpoints(directory)).length,
      1,
      "lost creation ACK creates one point"
    )
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), pendingKey), null)
    await dialog.locator('[data-testid^="computer-checkpoint-"]').waitFor()
    // Capture the fixed header while the actual body scrolls to its bottom.
    const headerTop = await dialog
      .getByRole("heading", { name: "电脑检查点", exact: true })
      .evaluate((element) => element.getBoundingClientRect().top)
    await dialog.getByRole("button", { name: "关闭", exact: true }).scrollIntoViewIfNeeded()
    assert.equal(
      await dialog
        .getByRole("heading", { name: "电脑检查点", exact: true })
        .evaluate((element) => element.getBoundingClientRect().top),
      headerTop
    )
    await page.screenshot({ path: join(output, "checkpoints-light.png"), animations: "disabled" })
    await page.evaluate("window.fixtureTheme('codex-dark')")
    await page.screenshot({ path: join(output, "checkpoints-dark.png"), animations: "disabled" })
    const live = new BotStore(database, undefined, undefined, workspace.path)
    const currentBot = live.getBot(bot.bot.id)
    live.updateBot({ id: currentBot.id, revision: currentBot.revision, name: "Later owner" })
    live.close()
    await writeFile(join(workspace.path, "note.txt"), "later work")
    await writeFile(join(directory, "browser-profile", "Local State"), "later profile")
    loseReply = true
    await dialog.getByRole("button", { name: "恢复", exact: true }).click()
    assert.match(
      await dialog.getByRole("region", { name: "确认电脑维护" }).innerText(),
      /旧任务停止/
    )
    await dialog.getByRole("button", { name: "确认操作", exact: true }).click()
    await dialog.getByText("回执暂时不可用", { exact: true }).waitFor()
    const originalRestore = calls[2]
    assert.equal(originalRestore.action, "restore")
    assert.equal(await readFile(join(workspace.path, "note.txt"), "utf8"), "captured work")
    await writeFile(join(workspace.path, "note.txt"), "edited after committed restore")
    // Simulate the actual root's new-epoch component remount while its receipt
    // was lost; persistence is computer scoped rather than epoch scoped.
    await page.evaluate("window.fixtureReopen()")
    await dialog.getByRole("button", { name: "核对原请求", exact: true }).waitFor()
    failRefresh = true
    await dialog.getByRole("button", { name: "核对原请求", exact: true }).click()
    await dialog.getByRole("button", { name: "重试连接", exact: true }).waitFor()
    assert.deepEqual(calls[3], originalRestore)
    assert.equal(
      await readFile(join(workspace.path, "note.txt"), "utf8"),
      "edited after committed restore",
      "receipt retry does not replace files again"
    )
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), pendingKey), null)
    failRefresh = false
    await dialog.getByRole("button", { name: "重试连接", exact: true }).click()
    await dialog.getByRole("button", { name: "重试连接", exact: true }).waitFor({ state: "hidden" })
    assert.equal(calls.length, 4, "reconnect never repeats an acknowledged restore")
    assert.equal(refreshes, 2)
    assert.equal(originalRestore.action, "restore")
    if (originalRestore.action !== "restore") throw new Error("Missing restore request")
    const code = dialog.getByRole("region", { name: "已恢复的代码成果", exact: true })
    await code
      .getByText(`代码成果 ${originalRestore.nonce.slice(0, 8)} · 1 个项目`, { exact: true })
      .waitFor()
    await dialog.getByRole("button", { name: "打开恢复的代码成果", exact: true }).click()
    await waitForNativeReveal(1)
    assert.deepEqual(
      revealed.map(({ kind, id }) => ({ kind, id })),
      [{ kind: "deliverables", id: originalRestore.nonce }]
    )
    const restoredStore = new BotStore(database, undefined, undefined, workspace.path)
    assert.equal(restoredStore.getBot(bot.bot.id).name, "Captured owner")
    assert.ok(
      restoredStore.db
        .exec("SELECT status FROM bot_runs")[0]
        .values.every((row) => row[0] === "cancelled")
    )
    restoredStore.close()
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()
    await page.getByRole("button", { name: "电脑检查点入口", exact: true }).click()
    const originals = await listBotComputerRecoveryCopies(directory)
    assert.equal(originals.length, 1)
    const originalRegion = dialog.getByRole("region", { name: "恢复前原现场", exact: true })
    await originalRegion.getByRole("button", { name: "打开原现场", exact: true }).click()
    await waitForNativeReveal(2)
    await originalRegion.getByRole("button", { name: "打开代码成果", exact: true }).click()
    await waitForNativeReveal(3)
    assert.deepEqual(
      revealed.map(({ kind, id }) => ({ kind, id })),
      [
        { kind: "deliverables", id: originalRestore.nonce },
        { kind: "original", id: originals[0].id },
        { kind: "deliverables", id: originals[0].id }
      ]
    )
    assert.notEqual(
      revealed[1].directory,
      revealed[2].directory,
      "raw original and independent code have separate native scopes"
    )
    loseDeletionReply = true
    await dialog
      .getByRole("button", { name: `删除原现场 ${originals[0].id.slice(0, 8)}`, exact: true })
      .click()
    await dialog.getByRole("button", { name: "确认操作", exact: true }).click()
    await dialog.getByText("清理回执暂时不可用", { exact: true }).waitFor()
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()
    await page.getByRole("button", { name: "电脑检查点入口", exact: true }).click()
    await dialog.getByRole("button", { name: "核对原请求", exact: true }).click()
    await dialog.getByText("原现场已删除", { exact: true }).waitFor()
    assert.deepEqual(deletionCalls, [
      { id: originals[0].id, sha256: originals[0].sha256 },
      { id: originals[0].id, sha256: originals[0].sha256 }
    ])
    assert.deepEqual(await listBotComputerRecoveryCopies(directory), [])
    await code.getByRole("button", { name: "打开代码成果", exact: true }).click()
    await waitForNativeReveal(4)
    assert.equal(
      revealed.at(-1)?.kind,
      "deliverables",
      "deleting the raw copy leaves restored code accessible"
    )
    assert.equal((await listBotComputerDeliverables(directory)).length, 1)
    // Failed local cleanup after a real successful receipt exposes a cleanup
    // action, rather than offering a new operation or repeating the old one.
    await page.evaluate("window.fixtureStorageRemovalFails=true")
    await dialog.getByRole("button", { name: "保存检查点", exact: true }).click()
    await dialog.getByRole("button", { name: "确认操作", exact: true }).click()
    await dialog.getByRole("button", { name: "清理已完成操作记录", exact: true }).waitFor()
    assert.equal(
      await dialog.getByRole("button", { name: "保存检查点", exact: true }).isDisabled(),
      true
    )
    const acceptedCalls = calls.length
    await page.evaluate("window.fixtureStorageRemovalFails=false")
    await dialog.getByRole("button", { name: "清理已完成操作记录", exact: true }).click()
    await dialog
      .getByRole("button", { name: "清理已完成操作记录", exact: true })
      .waitFor({ state: "hidden" })
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), pendingKey), null)
    assert.equal(calls.length, acceptedCalls, "known ACK cleanup does not dispatch again")
    // A held actual Host lock yields a typed definitive rejection. No nonce is
    // retained and no new point can be silently invented to compensate.
    const lock = BotHostLock.acquire(directory)
    assert.ok(lock)
    try {
      await dialog.getByRole("button", { name: "保存检查点", exact: true }).click()
      await dialog.getByRole("button", { name: "确认操作", exact: true }).click()
      await dialog
        .getByText("Bot 后台正在运行，请先停止后台后执行电脑维护", { exact: true })
        .waitFor()
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), pendingKey), null)
      assert.equal((await listBotComputerCheckpoints(directory)).length, 2)
    } finally {
      lock.release()
    }
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()
    await page.evaluate((key) => localStorage.setItem(key, "{corrupt-original"), pendingKey)
    await page.getByRole("button", { name: "电脑检查点入口", exact: true }).click()
    const repair = dialog.getByRole("region", { name: "修复损坏的操作记录", exact: true })
    await repair.waitFor()
    assert.equal(
      await repair.getByRole("button", { name: "确认清理损坏记录", exact: true }).isDisabled(),
      true
    )
    await repair.getByRole("button", { name: "复制原始记录", exact: true }).click()
    await repair.getByRole("button", { name: "已复制原始记录", exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.fixtureClipboard"), ["{corrupt-original"])
    const protectedIntent = { action: "create", nonce: "9033eb93-048b-423c-a030-87064c6168e1" }
    await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key: pendingKey,
      value: protectedIntent
    })
    await repair.getByRole("button", { name: "确认清理损坏记录", exact: true }).click()
    await dialog.getByRole("button", { name: "核对原请求", exact: true }).waitFor()
    assert.deepEqual(
      JSON.parse(await page.evaluate((key) => localStorage.getItem(key)!, pendingKey)),
      protectedIntent,
      "stale repair preserves a new valid pending intent"
    )
    assert.equal(calls.length, 6, "repair never executes a saved request")
    // Clear only a newly inspected exact corrupt value after its own copy.
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()
    await page.evaluate((key) => localStorage.setItem(key, "broken-second"), pendingKey)
    await page.getByRole("button", { name: "电脑检查点入口", exact: true }).click()
    await repair.getByRole("button", { name: "复制原始记录", exact: true }).click()
    await repair.getByRole("button", { name: "已复制原始记录", exact: true }).waitFor()
    await repair.getByRole("button", { name: "确认清理损坏记录", exact: true }).click()
    await repair.waitFor({ state: "hidden" })
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), pendingKey), null)
    const finalReads = progressReads
    await page.waitForTimeout(1100)
    assert.equal(
      progressReads,
      finalReads,
      "idle and completed calls release their progress observer"
    )
    await page.emulateMedia({ reducedMotion: "reduce" })
    assert.deepEqual(errors, [], "production checkpoint UI has no unhandled errors")
    console.log(
      JSON.stringify({
        checkpointUi: "PASS",
        calls: calls.length,
        deletionCalls: deletionCalls.length,
        refreshes,
        progressReads,
        output
      })
    )
  } finally {
    await browser.close()
    await rm(directory, { recursive: true, force: true })
    await rm(`${directory}.workspace`, { recursive: true, force: true })
    await rm(`${directory}-workspaces`, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
