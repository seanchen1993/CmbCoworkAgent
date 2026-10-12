import { afterEach, expect, it } from "vitest"
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotWorkflowStore, type BotWorkflowDefinition } from "./workflow-store"
import { botWorkflowFiles } from "./workflow-files"
import { BotArtifacts } from "./artifacts"
import type { BotRuntimeRequest } from "./host"

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const definition: BotWorkflowDefinition = {
  script: 'export const meta={name:"Files",description:"Files"}; return "ok";',
  maxConcurrency: 2,
  defaultModelId: "test-model",
  agentProfiles: [],
  authority: { project: "fixture" }
}
async function fixture(script = definition.script) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-workflow-files-")))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const project = join(root, "project"),
    privateRoot = join(root, "host")
  await mkdir(project)
  await mkdir(privateRoot)
  await writeFile(join(project, "source.txt"), "original")
  const dbPath = join(privateRoot, "bots.sqlite")
  let store = new BotStore(dbPath)
  cleanups.push(() => store.close())
  const { bot, conversationId } = store.createBot({
    nonce: "bot",
    name: "Worker",
    workspacePath: project
  })
  store.send({ nonce: "task", conversationId, text: "Prepare files" })
  const { run, lease } = store.claim("host-a")!
  const abort = new AbortController()
  let artifacts = new BotArtifacts(join(privateRoot, "objects"), store)
  cleanups.push(() => artifacts.close())
  let mode: "approve" | "reject" | "change" = "approve"
  let approvals = 0
  let workflow: BotWorkflowStore
  const adapter = async () => {
    const request: BotRuntimeRequest = {
      run,
      lease,
      bot,
      store,
      signal: abort.signal,
      messages: store.messagesForRun(run.id)
    }
    workflow = BotWorkflowStore.open(store, lease, "call", { ...definition, script })
    return botWorkflowFiles({
      request,
      workflow,
      artifacts,
      deniedRoots: [privateRoot],
      check: () => {
        abort.signal.throwIfAborted()
        store.assertDispatch(lease)
      },
      approve: async (id, action, operation) => {
        approvals++
        const before = await readFile(join(project, "source.txt"), "utf8")
        const interaction = store.requestInteraction(lease, {
          kind: "approval",
          prompt: JSON.stringify(action),
          action
        })
        expect(await readFile(join(project, "source.txt"), "utf8")).toBe(before)
        store.answerInteraction({
          id: interaction.id,
          revision: interaction.revision,
          answer: mode === "reject" ? "reject" : "approve"
        })
        if (mode === "reject") return "用户拒绝"
        if (mode === "change") await writeFile(join(project, "source.txt"), "someone else's edit")
        store.beginEffect(lease, { id, action, approvalId: interaction.id })
        try {
          const result = await operation()
          store.settleEffect(lease, id, "succeeded", result)
          return result
        } catch (error) {
          store.settleEffect(lease, id, "unknown", String(error))
          throw error
        }
      }
    })
  }
  return {
    root,
    workflow: () => workflow,
    check: () => {
      abort.signal.throwIfAborted()
      store.assertDispatch(lease)
    },
    project,
    signal: abort.signal,
    adapter,
    run,
    setMode: (value: typeof mode) => {
      mode = value
    },
    approvals: () => approvals,
    effects: () => store.effects(run.id),
    artifacts: () => store.artifacts(conversationId),
    reopen: async () => {
      await artifacts.close()
      store.close()
      store = new BotStore(dbPath)
      artifacts = new BotArtifacts(join(privateRoot, "objects"), store)
    }
  }
}

it("freezes observed inputs across restart while a later distinct read sees the current file", async () => {
  const test = await fixture(),
    files = await test.adapter()
  expect(await files.read("source.txt", test.signal, "read-1")).toBe("original")
  await writeFile(join(test.project, "source.txt"), "new data")
  expect(await files.read("source.txt", test.signal, "read-1")).toBe("original")
  expect(await files.read("source.txt", test.signal, "read-2")).toBe("new data")
  await test.reopen()
  const restored = await test.adapter()
  expect(await restored.read("source.txt", test.signal, "read-1")).toBe("original")
  await expect(restored.read("different.txt", test.signal, "read-1")).rejects.toThrow("身份已变化")
})

it("uses actual project approval, patch evidence and CAS; restart does not repeat an approved write", async () => {
  const test = await fixture(),
    files = await test.adapter()
  await files.write("source.txt", "approved change", test.signal, "write-1")
  expect(await readFile(join(test.project, "source.txt"), "utf8")).toBe("approved change")
  expect(test.approvals()).toBe(1)
  expect(test.effects()[0].status).toBe("succeeded")
  expect(test.artifacts().some((item) => item.name === "project-change.patch")).toBe(true)
  expect(test.artifacts().some((item) => item.name === "project-before.txt")).toBe(true)
  await test.reopen()
  await (await test.adapter()).write("source.txt", "approved change", test.signal, "write-1")
  expect(test.approvals()).toBe(1)
  expect(test.effects()).toHaveLength(1)
})

it("remembers rejection without asking again, and preserves a concurrent edit as an unresolved effect", async () => {
  const rejected = await fixture()
  rejected.setMode("reject")
  const files = await rejected.adapter()
  await expect(files.write("source.txt", "no", rejected.signal, "write-1")).rejects.toThrow(
    "未批准"
  )
  await expect(files.write("source.txt", "no", rejected.signal, "write-1")).rejects.toThrow(
    "未批准"
  )
  expect(rejected.approvals()).toBe(1)
  expect(await readFile(join(rejected.project, "source.txt"), "utf8")).toBe("original")
  const raced = await fixture()
  raced.setMode("change")
  await expect(
    (await raced.adapter()).write("source.txt", "proposal", raced.signal, "write-1")
  ).rejects.toThrow("审批期间文件已变化")
  expect(await readFile(join(raced.project, "source.txt"), "utf8")).toBe("someone else's edit")
  expect(raced.effects()[0].status).toBe("unknown")
  await raced.reopen()
  await expect(
    (await raced.adapter()).write("source.txt", "proposal", raced.signal, "write-1")
  ).rejects.toThrow("不能自动重复")
  expect(raced.approvals()).toBe(1)
})

it("keeps traversal, private paths and symlinks out of reads and glob, including after root replacement", async () => {
  const test = await fixture()
  await writeFile(join(test.root, "secret.txt"), "secret")
  await symlink(join(test.root, "secret.txt"), join(test.project, "link.txt"))
  await mkdir(join(test.project, ".git"))
  await writeFile(join(test.project, ".git", "secret.txt"), "git-internals")
  const files = await test.adapter()
  expect(await files.glob("**/*", test.signal, "glob-1")).toEqual(["source.txt"])
  for (const path of ["../secret.txt", "link.txt", "source.txt:stream", ".git/secret.txt"])
    await expect(files.read(path, test.signal, "read:" + path)).rejects.toThrow()
  expect(await files.read("source.txt", test.signal, "cached")).toBe("original")
  await rename(test.project, join(test.root, "old-project"))
  await mkdir(test.project)
  await expect(files.read("source.txt", test.signal, "cached")).rejects.toThrow("已被替换")
})

it("runs the actual isolated engine against Bot SQLite and approved project files, then replays after restart", async () => {
  const { build } = await import("esbuild")
  const { BotWorkflowProcess } = await import("./workflow-process")
  const test =
    await fixture(`export const meta={name:"Files",description:"Read, review and update"};
    const original = await readFile("source.txt");
    const reviewed = await agent("review:" + original);
    await writeFile("source.txt", original + ":" + reviewed);
    return await readFile("source.txt");`)
  const entry = join(test.root, "workflow.cjs")
  await build({
    entryPoints: ["src/main/bots/workflow-worker-entry.ts"],
    outfile: entry,
    platform: "node",
    format: "cjs",
    bundle: true,
    logLevel: "silent"
  })
  const process = new BotWorkflowProcess({ entry })
  let agents = 0
  const execute = async () => {
    const files = await test.adapter(),
      workflow = test.workflow()
    return process.execute(
      workflow.input,
      {
        store: workflow,
        files,
        check: test.check,
        isAwaitingApproval: () => false,
        progress: () => {},
        agent: async () => {
          agents++
          return { text: "verified", structured: undefined, outputTokens: 2 }
        }
      },
      test.signal
    )
  }
  expect(await execute()).toMatchObject({ status: "completed", result: "original:verified" })
  expect(await readFile(join(test.project, "source.txt"), "utf8")).toBe("original:verified")
  await test.reopen()
  expect(await execute()).toMatchObject({ status: "completed", result: "original:verified" })
  expect(agents).toBe(1)
  expect(test.approvals()).toBe(1)
  expect(test.effects()).toHaveLength(1)
}, 15_000)
