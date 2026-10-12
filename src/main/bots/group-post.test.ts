import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { botGroupPostTools, sendReviewedBotGroupPost } from "./group-post-tool"
import { groupPublicationApproval } from "../../shared/bot-group-post"
import type { BotRuntimeRequest } from "./host"
import type { ApproveLocalBotAction } from "./profile-tools"

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(origin = false, branch = false, waitForChild = true) {
  const directory = await mkdtemp(join(tmpdir(), "cmb-group-post-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const files = new BotArtifacts(join(directory, "objects"), store)
  cleanup.push(() => files.close())
  const a = store.createBot({ nonce: "a", name: "Owner" })
  const b = store.createBot({ nonce: "b", name: "Maker" })
  const c = store.createBot({ nonce: "c", name: "Reviewer" })
  const group = store.createGroup({
    nonce: "room",
    name: "交付评审",
    members: [a.bot.id, b.bot.id, c.bot.id]
  })
  let parent: ReturnType<BotStore["claim"]> = null
  let threadRootId: string | undefined
  if (origin) {
    if (branch) {
      const root = store.send({
        nonce: "root",
        conversationId: group.id,
        text: "PUBLIC_BRANCH_ROOT",
        recipients: [a.bot.id]
      })
      root.runIds.forEach((id) => store.cancel(id))
      threadRootId = root.messageId
    }
    store.send({
      nonce: "public-work",
      conversationId: group.id,
      text: "PUBLIC_USER_GOAL: 私下制作原文件，Reviewer 向本群交付。",
      recipients: [a.bot.id],
      threadRootId
    })
    parent = store.claim("host", 300_000)!
    const assigned = store.sendPeer(parent.lease, {
      nonce: "private-work",
      recipient: c.bot.id,
      text: "PRIVATE_ASSIGNMENT_SECRET"
    })
    if (waitForChild) store.waitForPeer(parent.lease, assigned.runIds[0])
  } else
    store.send({
      nonce: "private-work",
      conversationId: c.conversationId,
      text: "PRIVATE_USER_SECRET; 将完成的原件发到交付评审群。"
    })
  const claim = store.claim("host", 300_000)!
  expect(claim.run.botId).toBe(c.bot.id)
  const request: BotRuntimeRequest = {
    ...claim,
    store,
    bot: c.bot,
    messages: store.messagesForRun(claim.run.id),
    signal: new AbortController().signal
  }
  const bytes = Buffer.from("id,result\r\nsource,2391\r\n")
  const original = await files.publish(
    {
      id: "result-original",
      conversationId: c.conversationId,
      runId: claim.run.id,
      name: "result.csv",
      mime: "text/csv",
      origin: "generated"
    },
    bytes
  )
  const reviewed: unknown[] = []
  const approve: ApproveLocalBotAction = async (id, action, operation, commit) => {
    reviewed.push(action)
    const approval = store.requestInteraction(claim.lease, {
      kind: "approval",
      prompt: JSON.stringify(action),
      action
    })
    store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
    const apply = () =>
      store.approvedToolOnce(claim.lease, { id, action, approvalId: approval.id }, operation)
    return commit ? commit(apply) : apply()
  }
  const check = () => {
    store.assertDispatch(claim.lease)
  }
  const input = {
    callId: "publish",
    group_id: group.id,
    text: "核验完成，原件见附件。",
    files: [{ artifact_id: original.id }]
  }
  const post = (approval = approve) =>
    sendReviewedBotGroupPost(request, input, check, approval, files)
  return {
    directory,
    store,
    files,
    a,
    b,
    c,
    group,
    parent,
    threadRootId,
    request,
    original,
    bytes,
    reviewed,
    approve,
    check,
    input,
    post
  }
}

it("publishes exactly reviewed originals, preserves private scope, and replays one receipt after restart", async () => {
  const f = await fixture()
  const sent = JSON.parse(await f.post())
  const message = f.store.message({ conversationId: f.group.id, id: sent.messageId })
  expect(message).toMatchObject({ sender: "bot", botId: f.c.bot.id, text: f.input.text })
  expect(message.attachments).toHaveLength(1)
  const alias = message.attachments[0]
  expect(alias).not.toBe(f.original.id)
  expect(() => f.store.artifactForRun(f.request.run.id, alias)).toThrow()
  expect(message.attachmentFiles).toMatchObject([
    { id: alias, name: "result.csv", sha256: f.original.sha256 }
  ])
  expect((await f.files.read(alias)).bytes).toEqual(f.bytes)
  expect(f.reviewed).toHaveLength(1)
  expect(groupPublicationApproval.parse(f.reviewed[0]).groupPost).toMatchObject({
    destination: {
      id: f.group.id,
      name: f.group.name,
      members: [{ name: "Owner" }, { name: "Maker" }, { name: "Reviewer" }]
    },
    message: f.input.text,
    files: [{ sourceId: f.original.id, sha256: f.original.sha256 }]
  })
  expect(sent.runIds).toHaveLength(1)
  const target = f.store.getRun(sent.runIds[0])
  expect(target.botId).not.toBe(f.c.bot.id)
  expect(target.lane).toBe("agent")
  expect(f.store.artifactForRun(target.id, alias).sha256).toBe(f.original.sha256)
  expect(() => f.store.artifactForRun(target.id, f.original.id)).toThrow()
  expect(f.store.groups.reviewTask(target.id)).toBeNull()
  expect(f.store.groups.assignmentMessageId(target.id)).toBeNull()
  const scope = f.store.groups.scope(target.id)!
  expect(scope.prompt).toContain(f.input.text)
  expect(scope.prompt).not.toContain("PRIVATE_USER_SECRET")
  expect(f.store.messages(f.group.id)).toHaveLength(1)
  f.store.close()
  const reopened = new BotStore(join(f.directory, "bots.sqlite"))
  cleanup.push(() => reopened.close())
  vi.spyOn(f.files, "withPeerFiles").mockRejectedValue(new Error("must not reread"))
  const forbidApproval: ApproveLocalBotAction = async () => {
    throw new Error("must not ask again")
  }
  const repeat = await sendReviewedBotGroupPost(
    { ...f.request, store: reopened },
    f.input,
    () => {
      reopened.assertDispatch(f.request.lease)
    },
    forbidApproval,
    f.files
  )
  expect(JSON.parse(repeat)).toEqual(sent)
  expect(reopened.events().filter((event) => event.kind === "group.turn")).toHaveLength(1)
  await expect(
    sendReviewedBotGroupPost(
      { ...f.request, store: reopened },
      { ...f.input, text: "changed" },
      () => undefined,
      forbidApproval,
      f.files
    )
  ).rejects.toThrow()
})

it.each([false, true])(
  "publishes into the original active group (branch=%s) without cancelling its ancestor or another wake",
  async (branch) => {
    const f = await fixture(true, branch)
    const before = f.store.getRun(f.parent!.run.id)
    const turnsBefore = f.store.events().filter((event) => event.kind === "group.turn").length
    const list = f.store.groups.destinations(f.request.lease)
    expect(list.originatingGroup).toMatchObject({
      id: f.group.id,
      assignment: { text: expect.stringContaining("PUBLIC_USER_GOAL") }
    })
    expect(JSON.stringify(list)).not.toContain("PRIVATE_ASSIGNMENT_SECRET")
    const sent = JSON.parse(await f.post())
    expect(sent.runIds).toEqual([])
    expect(f.store.getRun(f.parent!.run.id)).toEqual(before)
    expect(f.store.groups.isCurrent(f.parent!.run.id)).toBe(true)
    const message = f.store.message({ conversationId: f.group.id, id: sent.messageId })
    expect(message.threadRootId).toBe(f.threadRootId)
    expect(message.replyTo).toBe(f.parent!.run.messageId)
    expect(f.store.events().filter((event) => event.kind === "group.turn")).toHaveLength(
      turnsBefore
    )
    expect(f.store.artifactForRun(f.parent!.run.id, message.attachments[0]).sha256).toBe(
      f.original.sha256
    ) // Only the current cycle's explicitly approved public file.
    f.store.finish(f.request.lease, "succeeded", "PRIVATE_FINISH")
    // The waiting group requester resumes; its next scheduled turn will observe
    // the publication and recognize that Reviewer has already delivered.
    f.store.waitForPeer(f.parent!.lease, f.request.run.id)
    const progress = f.store.groups.scope(f.parent!.run.id)!.prompt
    expect(progress).toContain("succeeded")
    expect(progress).not.toContain("PRIVATE_ASSIGNMENT_SECRET")
    f.store.finish(f.parent!.lease, "succeeded", "PRIVATE_COORDINATOR")
    f.store.advanceGroups()
    const next = f.store.claim("host", 300_000)!
    expect(f.store.groups.scope(next.run.id)!.prompt).not.toContain("PRIVATE_FINISH")
    expect(() => f.store.artifactForRun(f.parent!.run.id, message.attachments[0])).toThrow()
    expect(f.store.artifactForRun(next.run.id, message.attachments[0]).sha256).toBe(
      f.original.sha256
    )
  }
)

it.each([
  "membership",
  "group-revision",
  "bot-revision",
  "new-cycle",
  "target-cycle-cancel",
  "cancel",
  "revoked-file",
  "corrupt-file"
])("rechecks %s after review before any public effect", async (mode) => {
  const f = await fixture()
  const targetRun =
    mode === "target-cycle-cancel"
      ? f.store.send({
          nonce: "prior-cycle",
          conversationId: f.group.id,
          text: "群内原任务",
          recipients: [f.a.bot.id]
        }).runIds[0]
      : null
  const approval: ApproveLocalBotAction = async (id, action, operation, commit) => {
    if (targetRun) f.store.cancel(targetRun)
    if (mode === "membership" || mode === "group-revision")
      f.store.updateGroup({
        id: f.group.id,
        revision: f.group.revision,
        name: mode === "group-revision" ? "新群名" : f.group.name,
        description: "",
        members: mode === "membership" ? [f.a.bot.id, f.b.bot.id] : f.group.members
      })
    if (mode === "bot-revision")
      f.store.db.run("UPDATE bots SET revision=revision+1 WHERE id=?", [f.a.bot.id])
    if (mode === "new-cycle")
      f.store.send({ nonce: "new-cycle", conversationId: f.group.id, text: "new task" })
    if (mode === "cancel") f.store.cancel(f.request.run.id)
    if (mode === "revoked-file")
      f.store.db.run("UPDATE bot_artifact_lifecycle SET deleted_at=? WHERE artifact_id=?", [
        Date.now(),
        f.original.id
      ])
    if (mode === "corrupt-file")
      await writeFile(
        join(f.directory, "objects", f.original.sha256),
        Buffer.alloc(f.bytes.length, 1)
      )
    return f.approve(id, action, operation, commit)
  }
  await expect(f.post(approval)).rejects.toThrow()
  expect(f.store.messages(f.group.id).filter((message) => message.sender === "bot")).toEqual([])
  expect(f.store.artifacts(f.group.id)).toEqual([])
  expect(f.store.db.exec("SELECT * FROM bot_group_publications")[0].values).toEqual([])
  expect(
    f.store.db.exec("SELECT nonce FROM bot_receipts WHERE nonce=?", [
      `tool:${f.request.run.id}:publish`
    ])[0].values
  ).toEqual([])
})

it("rejects a cancelled original group and an unrelated or unknown group without approval", async () => {
  const f = await fixture(true)
  const other = f.store.createGroup({ nonce: "foreign", name: "其他群", members: [f.a.bot.id] })
  for (const group_id of [other.id, "unknown-group"])
    await expect(
      sendReviewedBotGroupPost(f.request, { ...f.input, group_id }, f.check, f.approve, f.files)
    ).rejects.toThrow()
  expect(f.reviewed).toEqual([])
  f.store.cancel(f.parent!.run.id)
  await expect(f.post()).rejects.toThrow()
  expect(f.store.messages(f.group.id).filter((message) => message.sender === "bot")).toEqual([])
})

it("rolls message, aliases, scheduler and approval back together on a failed commit", async () => {
  const f = await fixture()
  const execute = f.store.db.run.bind(f.store.db)
  const fail = vi.spyOn(f.store.db, "run").mockImplementation((sql, params) => {
    if (sql.startsWith("INSERT INTO bot_group_publications")) throw new Error("database failed")
    return execute(sql, params)
  })
  await expect(f.post()).rejects.toThrow("database failed")
  fail.mockRestore()
  expect(f.store.messages(f.group.id)).toEqual([])
  expect(f.store.artifacts(f.group.id)).toEqual([])
  expect(f.store.db.exec("SELECT * FROM bot_group_cycles")[0].values).toEqual([])
  expect(f.store.db.exec("SELECT * FROM bot_effects")[0].values).toEqual([])
  expect(f.store.hasToolResult(f.request.lease, "publish")).toBe(false)
})

it("exposes actual list and post tools and bounds additional public dispatches", async () => {
  const f = await fixture()
  const tools = botGroupPostTools(f.request, f.check, f.approve, f.files)
  const list = JSON.parse(await tools[0].invoke({}))
  expect(list.groups).toMatchObject([{ id: f.group.id, name: f.group.name }])
  const { callId, ...args } = f.input
  const result = await tools[1].invoke({
    name: "post_to_group",
    type: "tool_call",
    id: callId,
    args
  })
  expect(result.content).toContain('"posted":true')
  await sendReviewedBotGroupPost(
    f.request,
    { ...f.input, callId: "second", text: "补充核验记录" },
    f.check,
    f.approve,
    f.files
  )
  await expect(
    sendReviewedBotGroupPost(
      f.request,
      { ...f.input, callId: "third", text: "不应循环发言" },
      f.check,
      f.approve,
      f.files
    )
  ).rejects.toThrow("上限")
  expect(f.store.messages(f.group.id)).toHaveLength(2)
  expect(f.store.events().filter((event) => event.kind === "group.turn")).toHaveLength(1)
})

it.each(["continue", "stop", "new-human"])(
  "handles a late result's public continuation without confusing it with a new assignment (%s)",
  async (mode) => {
    const f = await fixture(true, false, false)
    // The user-facing group turn naturally completes while its private worker is
    // still running. A later result may legitimately require two public messages.
    f.store.toolOnce(f.parent!.lease, "parent-pass", {}, () =>
      f.store.groups.post(f.parent!.lease, "(pass)")
    )
    f.store.finish(f.parent!.lease, "succeeded", "PRIVATE_PARENT_FINISH")
    f.store.advanceGroups()
    const first = JSON.parse(await f.post())
    expect(first.runIds).toHaveLength(1)
    const next = () =>
      sendReviewedBotGroupPost(
        f.request,
        { ...f.input, callId: "late-second", text: "第二份交付说明" },
        f.check,
        f.approve,
        f.files
      )
    if (mode === "stop") f.store.cancel(first.runIds[0])
    if (mode === "new-human")
      f.store.send({
        nonce: "new-human",
        conversationId: f.group.id,
        text: "现在改做新任务",
        recipients: [f.a.bot.id]
      })
    if (mode === "continue") {
      const second = JSON.parse(await next())
      expect(second.runIds).toEqual([])
      expect(
        f.store.messages(f.group.id).filter((message) => message.sender === "bot")
      ).toHaveLength(2)
      expect(f.store.events().filter((event) => event.kind === "group.started")).toHaveLength(2)
    } else {
      // The original private lease remains live; the target's epoch fence is
      // what rejects reopening a stopped or replaced public discussion.
      f.store.assertDispatch(f.request.lease)
      await expect(next()).rejects.toMatchObject({ code: "group_epoch" })
      expect(
        f.store.messages(f.group.id).filter((message) => message.sender === "bot")
      ).toHaveLength(1)
    }
  }
)

it("counts the initial public post in the hard room-message budget", async () => {
  const f = await fixture()
  const first = JSON.parse(await f.post())
  expect(
    f.store.db.exec("SELECT round_messages,total_messages FROM bot_group_cycles WHERE id=?", [
      first.messageId
    ])[0].values
  ).toEqual([[1, 1]])
  f.store.finish(f.request.lease, "succeeded", "PRIVATE_DONE")
  for (let turn = 0; turn < 20; turn++) {
    f.store.advanceGroups()
    const claim = f.store.claim("host", 300_000)
    if (!claim) break
    for (let message = 0; message < 2; message++) {
      try {
        f.store.toolOnce(claim.lease, `progress-${message}`, {}, () =>
          f.store.groups.post(claim.lease, `进展 ${turn}/${message}`)
        )
      } catch (error) {
        expect(error).toMatchObject({ code: "group_message_limit" })
        break
      }
    }
    f.store.finish(claim.lease, "succeeded", "PRIVATE_SCRATCH")
  }
  expect(
    f.store.db.exec("SELECT total_messages,status FROM bot_group_cycles WHERE id=?", [
      first.messageId
    ])[0].values
  ).toEqual([[10, "completed"]])
  expect(f.store.messages(f.group.id).filter((message) => message.sender === "bot")).toHaveLength(
    10
  )
  expect(f.store.claim("host", 300_000)).toBeNull()
})
