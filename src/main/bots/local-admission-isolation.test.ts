import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotLocalToolGate } from "./local-tool-gate"
import { BotProjectFiles } from "./project-files"
import { botProjectChangeAction, commitBotProjectChange } from "./project-change"
import { ProjectFunctionFiles } from "../mods/v2/file-access"
import { BotArtifacts } from "./artifacts"
import { BotWorkflowStore } from "./workflow-store"
import { BotWorkflowProcess } from "./workflow-process"
import { botWorkflowFiles } from "./workflow-files"
import type { BotRuntimeRequest } from "./host"
import { build } from "esbuild"
import { setTimeout as delay } from "node:timers/promises"
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function fixture(choice: "ask" | "always" = "ask") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-local-admission-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, "workspace"),
    host = join(root, "host")
  await mkdir(workspace)
  await mkdir(host)
  let now = 1_800_000_000_000
  const store = new BotStore(join(host, "bots.sqlite"), () => now)
  cleanup.push(() => store.close())
  store.localTools.bind({
    target: { id: "a".repeat(64), label: "电脑", platform: "darwin" },
    assertCurrent: vi.fn()
  })
  const policy = (choice: "always" | "ask" | "never") => {
    const current = store.localTools.read()
    return store.localTools.change({
      nonce: `policy:${Math.random()}`,
      targetId: current.target.id,
      dataEpoch: current.dataEpoch,
      revision: current.revision,
      choice
    })
  }
  if (choice === "always") policy("always")
  const { bot, conversationId } = store.createBot({
    nonce: "bot",
    name: "项目助手",
    workspacePath: workspace
  })
  store.send({ nonce: "task", conversationId, text: "项目任务" })
  const { run, lease } = store.claim("host")!,
    controller = new AbortController()
  const request: BotRuntimeRequest = {
    bot,
    run,
    lease,
    store,
    signal: controller.signal,
    messages: store.messagesForRun(run.id)
  }
  const gate = BotLocalToolGate.open(request)!
  const answer = (id: string, resolution: "allow-once" | "always" | "deny" = "allow-once") => {
    const item = store.getInteraction(id),
      current = store.localTools.read()
    return store.localTools.resolve({
      nonce: `answer:${id}`,
      id,
      revision: item.revision,
      targetId: current.target.id,
      dataEpoch: current.dataEpoch,
      resolution
    })
  }
  const read = gate.read()
  await Promise.resolve()
  const initial = store
    .snapshot()
    .interactions.find((item) => item.status === "pending" && item.localProjectAccess)
  if (initial) answer(initial.id)
  await read
  const approve = (action: unknown) => {
    const item = store.requestInteraction(lease, {
      kind: "approval",
      prompt: JSON.stringify(action),
      action
    })
    store.answerInteraction({
      id: item.id,
      revision: item.revision,
      answer: "approve"
    })
    return item
  }
  return {
    root,
    host,
    workspace,
    store,
    request,
    gate,
    answer,
    approve,
    policy,
    controller,
    advance(ms: number) {
      while (ms > 0) {
        const step = Math.min(ms, 5000)
        now += step
        ms -= step
        store.renew(lease)
      }
    }
  }
}
async function until(test: () => boolean) {
  const deadline = Date.now() + 5000
  while (!test()) {
    if (Date.now() > deadline) throw Error("未出现续许可卡片")
    await delay(10)
  }
}
it("keeps two concurrent invocations bound to their exact actions and does not let another scope erase them", async () => {
  const f = await fixture("always"),
    a = { shell: { command: "foreground-A", cwd: f.workspace } },
    b = { shell: { command: "background-B", cwd: f.workspace } }
  const admissionA = await f.gate.mutation("A", a),
    approvalA = f.approve(a)
  const admissionB = await f.gate.mutation("B", b),
    approvalB = f.approve(b)
  admissionB!.bindEffect(approvalB.id)
  f.store.beginEffect(f.request.lease, {
    id: "B",
    action: b,
    approvalId: approvalB.id
  })
  f.store.settleEffect(f.request.lease, "B", "succeeded", "B done")
  // There is no shared clearMutation slot; finishing B cannot change A.
  admissionA!.bindEffect(approvalA.id)
  f.store.beginEffect(f.request.lease, {
    id: "A",
    action: a,
    approvalId: approvalA.id
  })
  const rows = f.store.db.exec(
    "SELECT approval_id,mutation_id FROM bot_local_tool_effect_permits"
  )[0].values
  expect(rows).toHaveLength(2)
  expect(rows[0][1]).not.toBe(rows[1][1])
  f.policy("never")
  expect(() => f.store.localTools.assertStartedEffect(f.request.lease, "A")).toThrow(/撤销|失效/)
  expect(f.store.effectResult(f.request.lease, "B")).toMatchObject({
    status: "succeeded",
    result: "B done"
  })
})
it("refuses another same-run approval even though both operations have valid local grants", async () => {
  const f = await fixture("always"),
    a = { shell: { command: "A", cwd: f.workspace } },
    b = { shell: { command: "B", cwd: f.workspace } }
  const admission = await f.gate.mutation("A", a),
    wrong = f.approve(b)
  expect(() => admission!.bindEffect(wrong.id)).toThrow(/审批/)
  expect(
    f.store.db.exec("SELECT COUNT(*) FROM bot_local_tool_effect_permits")[0].values[0][0]
  ).toBe(0)
})
it("checks the captured grant instead of accepting a different invocation's fresh grant after expiry", async () => {
  const f = await fixture("always"),
    a = { shell: { command: "A", cwd: f.workspace } },
    b = { shell: { command: "B", cwd: f.workspace } }
  const admission = await f.gate.mutation("A", a),
    approval = f.approve(a)
  f.advance(600001)
  await f.gate.mutation("B", b)
  expect(() => admission!.bindEffect(approval.id)).toThrow(/过期/)
})
it.each(["read", "glob", "exists", "workflow"] as const)(
  "asks again for a fresh workflow %s after expiry but reuses its completed observation",
  async (kind) => {
    const f = await fixture(),
      artifacts = new BotArtifacts(join(f.host, "objects"), f.store)
    cleanup.push(() => artifacts.close())
    await writeFile(join(f.workspace, "one.txt"), "first")
    await writeFile(join(f.workspace, "two.txt"), "new content")
    const workflow = BotWorkflowStore.open(f.store, f.request.lease, `wf-${kind}`, {
      script: 'export const meta={name:"Read",description:"Read"}; return "ok";',
      maxConcurrency: 2,
      defaultModelId: "model",
      agentProfiles: [],
      authority: { project: f.workspace }
    })
    const check = () => {
      f.request.signal.throwIfAborted()
      f.store.assertDispatch(f.request.lease, true)
      f.gate.assert()
    }
    const files = await botWorkflowFiles({
      request: f.request,
      workflow,
      artifacts,
      deniedRoots: [f.host],
      check,
      assertCurrent: async () => f.gate.assert(),
      admitRead: () => f.gate.read(),
      approve: async () => {
        throw Error("unexpected write")
      }
    })
    const call = (invocation: string) =>
      kind === "glob"
        ? files.glob("*.txt", f.request.signal, invocation)
        : kind === "exists"
          ? files.exists("two.txt", f.request.signal, invocation)
          : kind === "workflow"
            ? files.workflow("two.txt", f.request.signal, invocation)
            : files.read("two.txt", f.request.signal, invocation)
    const initial = await call("completed")
    f.advance(600001)
    expect(await call("completed")).toEqual(initial)
    let settled = false
    const fresh = call("fresh").finally(() => {
      settled = true
    })
    await until(() =>
      f.store
        .snapshot()
        .interactions.some((item) => item.localProjectAccess && item.status === "pending")
    )
    expect(settled).toBe(false)
    const card = f.store
      .snapshot()
      .interactions.find((item) => item.localProjectAccess && item.status === "pending")!
    f.answer(card.id)
    expect(await fresh).toEqual(initial)
  }
)
it("uses the actual isolated Workflow worker, blocks its second read and accepts the user's fresh card", async () => {
  const f = await fixture(),
    artifacts = new BotArtifacts(join(f.host, "objects"), f.store)
  cleanup.push(() => artifacts.close())
  await writeFile(join(f.workspace, "one.txt"), "first")
  await writeFile(join(f.workspace, "two.txt"), "SECRET_AFTER_TTL")
  const workflow = BotWorkflowStore.open(f.store, f.request.lease, "worker", {
    script:
      'export const meta={name:"Read",description:"Read"}; const one=await readFile("one.txt"); return {one,two:await readFile("two.txt")};',
    maxConcurrency: 2,
    defaultModelId: "model",
    agentProfiles: [],
    authority: { project: f.workspace }
  })
  const check = () => {
    f.request.signal.throwIfAborted()
    f.store.assertDispatch(f.request.lease, true)
    f.gate.assert()
  }
  const files = await botWorkflowFiles({
    request: f.request,
    workflow,
    artifacts,
    deniedRoots: [f.host],
    check,
    assertCurrent: async () => f.gate.assert(),
    admitRead: () => f.gate.read(),
    approve: async () => {
      throw Error("unexpected write")
    }
  })
  const read = files.read
  let second = false
  files.read = async (...args) => {
    const result = await read(...args)
    if (args[0] === "one.txt") f.advance(600001)
    else second = true
    return result
  }
  const entry = join(f.root, "workflow.cjs")
  await build({
    entryPoints: ["src/main/bots/workflow-worker-entry.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent"
  })
  const engine = new BotWorkflowProcess({ entry })
  const result = engine.execute(
    workflow.input,
    {
      store: workflow,
      files,
      check,
      isAwaitingApproval: () => f.store.getRun(f.request.run.id).status === "waiting_input",
      progress: () => {},
      agent: async () => {
        throw Error("unexpected agent")
      }
    },
    f.request.signal
  )
  cleanup.push(async () => {
    f.controller.abort()
    await result.catch(() => {})
  })
  await until(() =>
    f.store
      .snapshot()
      .interactions.some((item) => item.localProjectAccess && item.status === "pending")
  )
  expect(second).toBe(false)
  const card = f.store
    .snapshot()
    .interactions.find((item) => item.localProjectAccess && item.status === "pending")!
  f.answer(card.id)
  expect(await result).toMatchObject({
    status: "completed",
    result: { one: "first", two: "SECRET_AFTER_TTL" }
  })
}, 15000)
it("joins concurrent renewal readers on one card and releases cancelled waiting without new operations", async () => {
  const f = await fixture()
  f.advance(600001)
  const first = f.gate.read(),
    second = f.gate.read()
  await Promise.resolve()
  expect(
    f.store
      .snapshot()
      .interactions.filter((item) => item.localProjectAccess && item.status === "pending")
  ).toHaveLength(1)
  const completed = Promise.allSettled([first, second])
  f.controller.abort(new Error("已取消"))
  expect((await completed).map((item) => item.status)).toEqual(["rejected", "rejected"])
})
it("cancels one SDK reader without retiring the shared card another reader still owns", async () => {
  const f = await fixture()
  f.advance(600001)
  const cancelled = new AbortController(),
    live = new AbortController()
  const first = f.gate.read(cancelled.signal),
    second = f.gate.read(live.signal)
  const firstResult = first.catch((error) => error)
  await until(() =>
    f.store
      .snapshot()
      .interactions.some((item) => item.localProjectAccess && item.status === "pending")
  )
  const card = f.store
    .snapshot()
    .interactions.find((item) => item.localProjectAccess && item.status === "pending")!
  cancelled.abort(new Error("single reader cancelled"))
  expect(await firstResult).toMatchObject({
    message: "single reader cancelled"
  })
  expect(f.store.getInteraction(card.id).status).toBe("pending")
  f.answer(card.id)
  const admission = await second
  expect(() => admission.assert()).not.toThrow()
  expect(f.store.getInteraction(card.id).status).toBe("answered")
})
it("retires only the abandoned read card and allows a future original invocation to ask afresh", async () => {
  const f = await fixture()
  f.advance(600001)
  const controller = new AbortController(),
    result = f.gate.read(controller.signal).catch((error) => error)
  await until(() =>
    f.store
      .snapshot()
      .interactions.some((item) => item.localProjectAccess && item.status === "pending")
  )
  const card = f.store
    .snapshot()
    .interactions.find((item) => item.localProjectAccess && item.status === "pending")!
  controller.abort(new Error("abandoned read"))
  expect(await result).toMatchObject({ message: "abandoned read" })
  expect(f.store.getInteraction(card.id).status).toBe("expired")
  expect(f.store.getRun(f.request.run.id).status).toBe("running")
  const next = f.gate.read()
  await until(() =>
    f.store
      .snapshot()
      .interactions.some((item) => item.localProjectAccess && item.status === "pending")
  )
  const fresh = f.store
    .snapshot()
    .interactions.find((item) => item.localProjectAccess && item.status === "pending")!
  expect(fresh.id).not.toBe(card.id)
  f.answer(fresh.id)
  const admission = await next
  expect(() => admission.assert()).not.toThrow()
  expect(f.store.getInteraction(card.id).status).toBe("expired")
})
it("preserves an already answered card when its last consumer cancels before resuming", async () => {
  const f = await fixture()
  f.advance(600001)
  const controller = new AbortController(),
    read = f.gate.read(controller.signal).catch((error) => error)
  const card = f.store
    .snapshot()
    .interactions.find((item) => item.localProjectAccess && item.status === "pending")!
  f.answer(card.id)
  controller.abort(new Error("cancel after answer"))
  expect(await read).toMatchObject({ message: "cancel after answer" })
  expect(f.store.getInteraction(card.id).status).toBe("answered")
  expect(f.store.getInteraction(card.id).answer).toBe("approve")
})

it.each(["fs.read", "fs.list", "fs.exists", "fs.stat"] as const)(
  "fences an actual Function SDK %s before file access and releases an abandoned ask",
  async (method) => {
    const f = await fixture()
    f.advance(600001)
    await writeFile(join(f.workspace, "two.txt"), "NOT_READ_BEFORE_ALLOW")
    const controller = new AbortController()
    let publications = 0
    const files = new ProjectFunctionFiles(
      f.workspace,
      () => f.gate.assert(),
      async (value) => {
        publications++
        return value
      },
      undefined,
      undefined,
      (signal) => f.gate.read(signal)
    )
    const pending = files
      .run(method, method === "fs.list" ? "." : "two.txt", controller.signal)
      .catch((error) => error)
    const card = f.store
      .snapshot()
      .interactions.find((item) => item.localProjectAccess && item.status === "pending")!
    controller.abort(new Error("SDK call cancelled"))
    expect(await pending).toMatchObject({ message: "SDK call cancelled" })
    expect(publications).toBe(0)
    expect(f.store.getInteraction(card.id).status).toBe("expired")
    expect(f.store.getRun(f.request.run.id).status).toBe("running")
  }
)
it("collects a completed Function SDK read without reauthorizing a result after TTL expires", async () => {
  const f = await fixture()
  await writeFile(join(f.workspace, "two.txt"), "COMPLETED_READ")
  let admissions = 0
  const files = new ProjectFunctionFiles(
    f.workspace,
    () => f.gate.assert(),
    async (value) => {
      f.advance(600001)
      return value
    },
    undefined,
    undefined,
    (signal) => {
      admissions++
      return f.gate.read(signal)
    }
  )
  expect(await files.run("fs.read", "two.txt", f.request.signal)).toBe("COMPLETED_READ")
  expect(admissions).toBe(1)
  expect(
    f.store
      .snapshot()
      .interactions.filter((item) => item.localProjectAccess && item.status === "pending")
  ).toHaveLength(0)
})

it("rebinds a new read admission only for this write card's explicit Always upgrade", async () => {
  const f = await fixture(),
    oldReadHandle = await f.gate.read(),
    originalReadId = String(
      f.store.db.exec(
        "SELECT id FROM bot_local_tool_requests WHERE run_id=? AND json_extract(record,'$.card.action.kind')='read-file'",
        [f.request.run.id]
      )[0].values[0][0]
    ),
    artifacts = new BotArtifacts(join(f.host, "objects"), f.store)
  cleanup.push(() => artifacts.close())
  await writeFile(join(f.workspace, "one.txt"), "before")
  const project = await BotProjectFiles.open(f.workspace, [f.host]),
    before = await project.read("one.txt"),
    change = await project.prepare({
      path: "one.txt",
      expectedHash: before.sha256,
      content: "after"
    }),
    action = botProjectChangeAction(project.root, change)
  const pending = f.gate.mutation("write", action)
  await until(() =>
    f.store
      .snapshot()
      .interactions.some(
        (item) => item.status === "pending" && item.localProjectAccess?.action.kind === "write-file"
      )
  )
  const card = f.store
    .snapshot()
    .interactions.find(
      (item) => item.status === "pending" && item.localProjectAccess?.action.kind === "write-file"
    )!
  f.answer(card.id, "always")
  const admission = (await pending)!
  expect(() => oldReadHandle.assert()).toThrow(/撤销|失效/)
  expect(() => f.gate.assert()).not.toThrow()
  const original = JSON.parse(
    String(
      f.store.db.exec("SELECT record FROM bot_local_tool_requests WHERE id=?", [originalReadId])[0]
        .values[0][0]
    )
  )
  expect(original.status).toBe("retired")
  expect(f.store.snapshot().interactions.filter((item) => item.status === "pending")).toEqual([])
  // The device upgrade does not approve the file diff: its ordinary action
  // still has a separate human approval before the actual production writer.
  const approval = f.approve(action)
  admission.bindEffect(approval.id)
  const readId = String(
    f.store.db.exec("SELECT read_id FROM bot_local_tool_effect_permits WHERE approval_id=?", [
      approval.id
    ])[0].values[0][0]
  )
  expect(readId).not.toBe(originalReadId)
  f.store.beginEffect(f.request.lease, { id: "write", action, approvalId: approval.id })
  const result = await commitBotProjectChange(f.request, artifacts, project, change, "write", () =>
    f.gate.assert()
  )
  f.store.settleEffect(f.request.lease, "write", "succeeded", result)
  expect((await project.read("one.txt")).text).toBe("after")
  expect(f.store.effectResult(f.request.lease, "write")).toMatchObject({
    status: "succeeded",
    result
  })
  expect(f.store.effects(f.request.run.id)).toHaveLength(1)
  // A captured/retired handle is never revived even though a fresh standing
  // read now renews without another card after ten minutes.
  expect(
    f.store.localTools.readUpgradeInvocation(f.request.lease, originalReadId, readId)
  ).toBeUndefined()
  f.advance(600_001)
  const renewed = await f.gate.read()
  expect(() => renewed.assert()).not.toThrow()
  expect(() => oldReadHandle.assert()).toThrow(/撤销|失效/)
  expect(f.store.snapshot().interactions.filter((item) => item.status === "pending")).toEqual([])
})

function pendingLocal(f: Awaited<ReturnType<typeof fixture>>, kind: "read-file" | "write-file") {
  return f.store
    .snapshot()
    .interactions.find(
      (item) => item.status === "pending" && item.localProjectAccess?.action.kind === kind
    )
}
it("keeps an expired waiting write alive and obtains fresh write/read answers before any effect", async () => {
  const f = await fixture()
  const result = f.gate.mutation("write", { project: { path: "one.txt" } })
  let settled = false
  void result.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  cleanup.push(async () => {
    f.controller.abort()
    await result.catch(() => {})
  })
  await until(() => Boolean(pendingLocal(f, "write-file")))
  const old = pendingLocal(f, "write-file")!
  f.advance(600_001)
  await until(() => f.store.getInteraction(old.id).status === "expired")
  const renewed = pendingLocal(f, "write-file")!
  expect(renewed.id).not.toBe(old.id)
  expect(settled).toBe(false)
  expect(f.store.getRun(f.request.run.id).status).toBe("waiting_input")
  expect(f.store.effects(f.request.run.id)).toEqual([])
  expect(() => f.answer(old.id)).toThrow()
  f.answer(renewed.id)
  await until(() => Boolean(pendingLocal(f, "read-file")))
  expect(settled).toBe(false)
  f.answer(pendingLocal(f, "read-file")!.id)
  const admission = await result
  expect(() => admission!.assert()).not.toThrow()
  expect(f.store.effects(f.request.run.id)).toEqual([])
})
it("shares one fresh approval for concurrent readers when their pending card naturally expires", async () => {
  const f = await fixture()
  f.advance(600_001)
  const first = f.gate.read(),
    second = f.gate.read()
  const result = Promise.all([first, second])
  cleanup.push(async () => {
    f.controller.abort()
    await result.catch(() => {})
  })
  await until(() => Boolean(pendingLocal(f, "read-file")))
  const old = pendingLocal(f, "read-file")!
  f.advance(600_001)
  await until(() => f.store.getInteraction(old.id).status === "expired")
  const fresh = pendingLocal(f, "read-file")!
  expect(fresh.id).not.toBe(old.id)
  expect(f.store.snapshot().interactions.filter((item) => item.status === "pending")).toHaveLength(
    1
  )
  f.answer(fresh.id)
  for (const handle of await result) expect(() => handle.assert()).not.toThrow()
})
it.each(["allow-once", "always"] as const)(
  "renews a write with %s after the renewed read outlasts that write grant",
  async (resolution) => {
    const f = await fixture()
    const captured = await f.gate.read()
    f.advance(500_000)
    const result = f.gate.mutation("write", { project: { path: "one.txt" } })
    cleanup.push(async () => {
      f.controller.abort()
      await result.catch(() => {})
    })
    await until(() => Boolean(pendingLocal(f, "write-file")))
    const firstWrite = pendingLocal(f, "write-file")!
    f.advance(100_001)
    f.answer(firstWrite.id)
    await until(() => Boolean(pendingLocal(f, "read-file")))
    f.advance(500_001)
    f.answer(pendingLocal(f, "read-file")!.id)
    await until(() => Boolean(pendingLocal(f, "write-file")))
    expect(pendingLocal(f, "write-file")!.id).not.toBe(firstWrite.id)
    expect(f.store.getInteraction(firstWrite.id).answer).toBe("approve")
    expect(() => captured.assert()).toThrow(/过期/)
    f.answer(pendingLocal(f, "write-file")!.id, resolution)
    const admission = await result
    expect(() => admission!.assert()).not.toThrow()
    expect(f.store.effects(f.request.run.id)).toEqual([])
  }
)
it.each(["never", "ask", "always"] as const)(
  "does not reopen an expired waiting write after policy changes to %s",
  async (choice) => {
    const f = await fixture()
    const result = f.gate
      .mutation("write", { project: { path: "one.txt" } })
      .catch((error) => error)
    await until(() => Boolean(pendingLocal(f, "write-file")))
    f.policy(choice)
    f.advance(600_001)
    expect(await result).toMatchObject({ code: "local_permission_retired" })
    expect(f.store.snapshot().interactions.filter((item) => item.status === "pending")).toEqual([])
    expect(f.store.effects(f.request.run.id)).toEqual([])
  }
)
it("does not renew a denied or aborted waiting mutation", async () => {
  const f = await fixture()
  const denied = f.gate.mutation("denied", { project: { path: "one.txt" } }).catch((error) => error)
  await until(() => Boolean(pendingLocal(f, "write-file")))
  f.answer(pendingLocal(f, "write-file")!.id, "deny")
  f.advance(600_001)
  expect(await denied).toMatchObject({ code: "local_permission_retired" })
  const waiting = f.gate.read().catch((error) => error)
  await until(() => Boolean(pendingLocal(f, "read-file")))
  f.advance(600_001)
  f.controller.abort(new Error("cancelled before renewal"))
  expect(await waiting).toMatchObject({ message: "cancelled before renewal" })
  expect(f.store.effects(f.request.run.id)).toEqual([])
})
