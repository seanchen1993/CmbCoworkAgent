import { afterEach, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StructuredToolInterface } from "@langchain/core/tools"
import { BotProjectFiles } from "./project-files"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { botProjectTools } from "./project-tools"
import { botSkillResourceTools } from "./skill-resource-tools"
import { BotDocumentReader } from "./document-reader"
import { assertSkillResources, scanSkillResources, skillFileStamp } from "./skill-resource-files"
import type { BotRuntimeRequest } from "./host"

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
async function fixture(original = Buffer.from("\ufeffconst a = 1\r\nconst b = 2\r\n")) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "bot-project-encoding-")))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const root = join(base, "project"),
    host = join(base, "host")
  await mkdir(root)
  await mkdir(host)
  await writeFile(join(root, "app.ts"), original)
  const project = await BotProjectFiles.open(root)
  const store = new BotStore(join(host, "bots.sqlite"))
  cleanups.push(() => store.close())
  const files = new BotArtifacts(join(host, "objects"), store)
  cleanups.push(() => files.close())
  const { bot, conversationId } = store.createBot({
    nonce: "bot",
    name: "Editor",
    workspacePath: root
  })
  store.send({ nonce: "task", conversationId, text: "Update approved project files" })
  const claimed = store.claim("test-host", 300_000)!
  const request: BotRuntimeRequest = {
    ...claimed,
    bot,
    store,
    messages: store.messagesForRun(claimed.run.id),
    signal: new AbortController().signal
  }
  const check = () => store.assertDispatch(claimed.lease)
  const approvals: unknown[] = []
  let whileApproving: (() => Promise<void>) | undefined
  const approve = async (id: string, action: unknown, operation: () => Promise<string>) => {
    approvals.push(action)
    const card = store.requestInteraction(claimed.lease, {
      kind: "approval",
      prompt: JSON.stringify(action),
      action
    })
    store.answerInteraction({ id: card.id, revision: card.revision, answer: "approve" })
    await whileApproving?.()
    store.beginEffect(claimed.lease, { id, action, approvalId: card.id })
    try {
      const result = await operation()
      store.settleEffect(claimed.lease, id, "succeeded", result)
      return result
    } catch (error) {
      store.settleEffect(claimed.lease, id, "unknown", String(error))
      throw error
    }
  }
  const tools = await botProjectTools(request, files, check, approve, [host])
  const invoke = async (
    name: string,
    args: Record<string, unknown>,
    id = "call",
    available = tools
  ) => {
    const result = await available
      .find((tool) => tool.name === name)!
      .invoke({ name, args, id, type: "tool_call" })
    return JSON.parse(String(result.content))
  }
  return {
    base,
    root,
    project,
    original,
    files,
    store,
    request,
    approvals,
    approve,
    check,
    invoke,
    changeDuringApproval: (callback: () => Promise<void>) => {
      whileApproving = callback
    },
    artifacts: () => store.artifacts(conversationId),
    effects: () => store.effects(claimed.run.id),
    async skill(bytes: Buffer): Promise<{ id: string; tools: StructuredToolInterface[] }> {
      const skillRoot = join(base, "skill")
      await mkdir(skillRoot)
      const filePath = join(skillRoot, "SKILL.md"),
        instructions = "---\nname: encoding\n---\nCopy the exact template.\n"
      await writeFile(filePath, instructions)
      await writeFile(join(skillRoot, "template.ts"), bytes)
      const id = `desktop:${sha(Buffer.from(filePath))}`
      store.externalSkills.apply({
        warnings: [],
        truncated: false,
        skills: [
          {
            id,
            catalogId: id,
            name: "encoding",
            description: "Exact template",
            instructions,
            sha256: sha(Buffer.from(instructions)),
            fileStamp: skillFileStamp(await stat(filePath, { bigint: true })),
            filePath,
            catalogPath: filePath,
            rootPath: skillRoot,
            resources: await scanSkillResources(skillRoot),
            compatibility: "",
            pluginId: null,
            pluginName: null,
            source: "user"
          }
        ]
      })
      store.externalSkills.bindGuard((skill) => {
        if (skill) assertSkillResources(skill)
      })
      return {
        id,
        tools: botSkillResourceTools(request, check, new BotDocumentReader(), {
          files,
          deniedRoots: [host],
          approve
        })
      }
    }
  }
}

it.each(["replace", "full"])(
  "preserves UTF-8 BOM and CRLF through %s, backup, replay and an exact restore",
  async (mode) => {
    const f = await fixture()
    const observed = await f.invoke("project_read", { path: "app.ts" }, "read")
    expect(Buffer.from(observed.text)).toEqual(f.original)
    expect(observed.sha256).toBe(sha(f.original))
    const args = {
      path: "app.ts",
      expected_sha256: observed.sha256,
      ...(mode === "replace"
        ? { old_text: "const a = 1\nconst b = 2", new_text: "const a = 3\nconst b = 2" }
        : { content: "const a = 3\nconst b = 2\n" })
    }
    const reply = await f.invoke("project_edit", args, "edit")
    const expected = Buffer.from("\ufeffconst a = 3\r\nconst b = 2\r\n")
    expect(await readFile(join(f.root, "app.ts"))).toEqual(expected)
    expect(reply.sha256).toBe(sha(expected))
    const backup = await f.files.read(reply.beforeArtifactId)
    expect(backup.bytes).toEqual(f.original)
    expect(sha(backup.bytes)).toBe(observed.sha256)
    const afterArtifacts = f.artifacts().length
    expect(await f.invoke("project_edit", args, "edit")).toEqual(reply)
    expect(f.approvals).toHaveLength(1)
    expect(f.effects()).toHaveLength(1)
    expect(f.artifacts()).toHaveLength(afterArtifacts)
    await f.invoke(
      "project_edit",
      {
        path: "app.ts",
        expected_sha256: reply.sha256,
        content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(backup.bytes)
      },
      "restore"
    )
    expect(await readFile(join(f.root, "app.ts"))).toEqual(f.original)
  }
)

it("keeps unrelated mixed line endings and an explicitly supplied BOM without duplication", async () => {
  const f = await fixture(Buffer.from("\ufefffirst\r\nsecond\nthird\r\n"))
  const change = await f.project.prepare({
    path: "app.ts",
    expectedHash: sha(f.original),
    oldText: "second",
    newText: "changed"
  })
  expect(change.beforeBytes).toEqual(f.original)
  await f.project.commit(change, () => {})
  expect(await readFile(join(f.root, "app.ts"))).toEqual(
    Buffer.from("\ufefffirst\r\nchanged\nthird\r\n")
  )
  const full = await f.project.prepare({
    path: "app.ts",
    expectedHash: change.afterHash,
    content: "\ufeffnew\r\n"
  })
  await f.project.commit(full, () => {})
  expect(await readFile(join(f.root, "app.ts"))).toEqual(Buffer.from("\ufeffnew\r\n"))
})

it("keeps new-file bytes exact and rejects invalid UTF-8 or NUL inputs before preparing an edit", async () => {
  const f = await fixture()
  const created = await f.project.prepare({
    path: "new.ts",
    expectedHash: null,
    content: "\ufeffnew\r\n"
  })
  expect(created.beforeBytes).toBeNull()
  await f.project.commit(created, () => {})
  expect(await readFile(join(f.root, "new.ts"))).toEqual(Buffer.from("\ufeffnew\r\n"))
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0x61, 0])]) {
    await writeFile(join(f.root, "app.ts"), bytes)
    await expect(
      f.project.prepare({ path: "app.ts", expectedHash: sha(bytes), content: "replacement" })
    ).rejects.toThrow()
    expect(await readFile(join(f.root, "app.ts"))).toEqual(bytes)
  }
})

it.each(["bom", "line-endings"])(
  "rejects a concurrent %s-only change after approval without overwriting it",
  async (kind) => {
    const f = await fixture()
    const changed =
      kind === "bom"
        ? f.original.subarray(3)
        : Buffer.from(f.original.toString().replaceAll("\r\n", "\n"))
    f.changeDuringApproval(() => writeFile(join(f.root, "app.ts"), changed))
    const args = { path: "app.ts", expected_sha256: sha(f.original), old_text: "1", new_text: "3" }
    await expect(f.invoke("project_edit", args, "edit")).rejects.toThrow("审批期间文件已变化")
    expect(await readFile(join(f.root, "app.ts"))).toEqual(changed)
    const before = f.artifacts().find((artifact) => artifact.name === "project-before.txt")!
    expect((await f.files.read(before.id)).bytes).toEqual(f.original)
    await expect(f.invoke("project_edit", args, "edit")).rejects.toThrow("不能自动重复")
    expect(f.approvals).toHaveLength(1)
  }
)

it("publishes the exact BOM/CRLF original and fences a byte-only change during publication approval", async () => {
  const f = await fixture()
  const result = await f.invoke("project_publish", { path: "app.ts" }, "publish")
  expect((await f.files.read(result.id)).bytes).toEqual(f.original)
  expect(result.sha256).toBe(sha(f.original))
  expect(await f.invoke("project_publish", { path: "app.ts" }, "publish")).toEqual(result)
  expect(f.artifacts()).toHaveLength(1)
  const delivered = f.store
    .messages(f.request.run.conversationId)
    .filter((message) => message.attachments.includes(result.id))
  expect(delivered).toHaveLength(1)
  expect(delivered[0]).toMatchObject({
    runId: f.request.run.id,
    sender: "system",
    text: "已交付：app.ts"
  })
  f.changeDuringApproval(() => writeFile(join(f.root, "app.ts"), f.original.subarray(3)))
  await expect(f.invoke("project_publish", { path: "app.ts" }, "raced-publish")).rejects.toThrow(
    "审批期间文件已变化"
  )
  expect(f.artifacts()).toHaveLength(1)
  expect(
    f.store.messages(f.request.run.conversationId).filter((m) => m.attachments.length)
  ).toEqual(delivered)
})

it("rejects invalid publication names before approval or effects, then permits an exact nested original", async () => {
  const f = await fixture()
  await mkdir(join(f.root, "src"))
  await writeFile(join(f.root, "src/money.js"), f.original)
  for (const [index, name] of [
    "src/money.js",
    "src\\money.js",
    "CON.js",
    "../money.js",
    "money.js.",
    "   ",
    "money\0.js"
  ].entries()) {
    const feedback = await f.invoke(
      "project_publish",
      { path: "src/money.js", name },
      `bad-${index}`
    )
    expect(feedback).toMatchObject({ error: "invalid_filename" })
    expect(f.approvals).toHaveLength(0)
    expect(f.effects()).toHaveLength(0)
    expect(f.artifacts()).toHaveLength(0)
  }
  const result = await f.invoke("project_publish", { path: "src/money.js" }, "nested")
  expect(result).toMatchObject({ name: "money.js", sha256: sha(f.original) })
  expect((await f.files.read(result.id)).bytes).toEqual(f.original)
  expect(f.approvals).toHaveLength(1)
  expect(f.effects()).toHaveLength(1)
  expect(f.effects()[0].status).toBe("succeeded")
  expect(await f.invoke("project_publish", { path: "src/money.js" }, "nested")).toEqual(result)
  expect(f.approvals).toHaveLength(1)
  expect(
    f.store.messages(f.request.run.conversationId).filter((m) => m.attachments.includes(result.id))
  ).toHaveLength(1)
})

it.each([
  ["\ufefftarget\r\n", "source\n"],
  ["target\n", "\ufeffsource\r\n"]
])(
  "copies an installed UTF-8 skill byte-for-byte across different target formats",
  async (target, source) => {
    const f = await fixture(Buffer.from(target)),
      original = Buffer.from(source)
    const skill = await f.skill(original)
    const result = await f.invoke(
      "copy_skill_file",
      {
        id: skill.id,
        path: "template.ts",
        destination: "app.ts",
        expected_sha256: sha(f.original)
      },
      "skill-copy",
      skill.tools
    )
    expect(await readFile(join(f.root, "app.ts"))).toEqual(original)
    expect(result.sha256).toBe(sha(original))
    expect((await f.files.read(result.beforeArtifactId)).bytes).toEqual(f.original)
  }
)
