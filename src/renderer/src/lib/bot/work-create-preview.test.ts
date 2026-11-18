import { readFileSync } from "node:fs"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import type { BotWorkApproval } from "../../../../shared/bots/work"
import type { SendBotMessageInput } from "../../../../shared/bots/contracts"
import type { QueuedMessage } from "../../types"
import type { ThreadActions } from "../thread-context"
import { BotDraftSender } from "../bot-draft-sender"
import { botWorkClient } from "../bot-work-client"
import { getQueuedBotWorkCreationInput } from "../queued-message-content"

function handler(file: string, component: string, name: string, scope: Record<string, unknown>) {
  const source = ts.createSourceFile(file,
    readFileSync(new URL(`../../components/bots/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest)
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === component)
  const statement = declaration?.body?.statements.find(node => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === name))
  if (!statement) throw new Error(`Missing ${component}.${name}`)
  const js = ts.transpileModule(statement.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return new Function(...Object.keys(scope), `${js}; return ${name}`)(...Object.values(scope))
}

function navigation(canPreviewWork = true) {
  const selectWork = vi.fn(), openWorkPreview = vi.fn(), trigger = {}
  const openWork = handler("BotsWorkspace.tsx", "BotWorkspaceForHost", "openWork", {
    canPreviewWork, selectWork, openWorkPreview, detailTriggerRef: { current: trigger },
    works: { items: [{ id: "existing", title: "已有任务" }, { id: "channel", source: { transport: "im" } }], priority: [] },
    useCallback: (fn: unknown) => fn
  }) as (id: string | null) => void
  return { openWork, selectWork, openWorkPreview, trigger }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const pending = new Promise<T>(finish => { resolve = finish })
  return { pending, resolve }
}

function workspaceFixture() {
  const trigger = {}
  const appState = { mainView: "bots", showCustomizeView: false }
  const preview = { current: null as { botId: string; workId: string } | null }
  const setWorkPreview = vi.fn((value: typeof preview.current) => { preview.current = value })
  const workPreviewNavigation = { current: { preview: null } }
  const workPreviewReturn = { current: null }
  const approvalNavigation = { current: null }
  const view = { detailTab: "details", detailOpen: true }
  const workspace = (name: string, dependencies: Record<string, unknown> = {}) =>
    handler("BotsWorkspace.tsx", "BotWorkspaceForHost", name, {
      canPreviewWork: true, currentBotId: "bot", client: { hostId: "local" }, detailOpen: false,
      useAppStore: { getState: () => appState }, useCallback: (fn: unknown) => fn,
      workPreviewReturn, workPreviewNavigation, approvalNavigation, setWorkPreview,
      view, updateView: (patch: Partial<typeof view>) => Object.assign(view, patch),
      document: { activeElement: null }, ...dependencies
    })
  const openWorkPreview = workspace("openWorkPreview") as (id: string, trigger: object, title: string) => void
  const captureWorkNavigation = workspace("captureWorkNavigation") as () => () => boolean
  const setDetailTab = workspace("setDetailTab") as (tab: "details" | "files" | "computer") => void
  const setDetailOpen = workspace("setDetailOpen") as (open: boolean) => void
  const closePreview = () => workspace("closeWorkPreview", {
    dismissWorkPreview: workspace("dismissWorkPreview"), requestAnimationFrame: vi.fn()
  })()
  const openOriginalChat = () => {
    const thread = deferred<string>()
    const openBotWorkThreadChat = vi.fn()
    const opening = workspace("openPreviewConversation", {
      preview: preview.current, previewWork: { id: "existing" },
      works: { current: { current: { botId: "bot", selectedId: "existing" } } },
      resolveBotWorkThreadForNavigation: () => thread.pending,
      dismissWorkPreview: workspace("dismissWorkPreview"),
      openBotWorkThreadChat, threadContext: {}
    })()
    return async () => {
      thread.resolve("original-thread")
      await opening
      expect(openBotWorkThreadChat).toHaveBeenCalledExactlyOnceWith({}, "original-thread")
      expect(preview.current).toBeNull()
    }
  }
  const openApproval = () => {
    const work = { id: "approval-work", botId: "bot", threadId: "approval-thread" }
    const approval: BotWorkApproval = {
      kind: "approval", taskId: "approval-run", requestId: "approval-request", workId: work.id,
      workTitle: "Approval work", askedBy: "Bot",
      target: { botId: work.botId, threadId: work.threadId, workId: work.id }
    }
    const pending = deferred<BotWorkApproval[]>()
    const openBotWorkThreadChat = vi.fn()
    const opening = workspace("openWorkApproval", {
      selected: { id: work.botId }, activeWorkId: null, selectedIm: null,
      captureWorkNavigation,
      client: { hostId: "local", works: { pendingQuestions: () => pending.pending, get: async () => work } },
      resolveBotWorkThreadForNavigation: async () => work.threadId, openBotWorkThreadChat, threadContext: {}
    })(approval, () => true)
    return async () => {
      pending.resolve([approval])
      await opening
      expect(openBotWorkThreadChat).toHaveBeenCalledExactlyOnceWith({}, work.threadId)
      expect(preview.current).toBeNull()
    }
  }
  return { appState, trigger, preview, workspace, setWorkPreview, openWorkPreview,
    captureWorkNavigation, closePreview, openOriginalChat, openApproval, setDetailTab, setDetailOpen, view }
}

function creationFixture() {
  const navigation = workspaceFixture()
  const { trigger, openWorkPreview, captureWorkNavigation } = navigation
  const receipt = { work: { id: "created", title: "新任务" } }
  const result = deferred<typeof receipt>()
  const scope = {
    client: { works: { create: vi.fn(() => result.pending) } }, botId: "bot", saving: false,
    title: receipt.work.title, goal: "Review", directoryPath: "", command: () => "operation",
    operation: { current: {} }, controller: { current: { current: { botId: "bot" } }, refresh: vi.fn() },
    setSaving: vi.fn(), setError: vi.fn(), setEditing: vi.fn(), setTitle: vi.fn(),
    setGoal: vi.fn(), setDirectoryPath: vi.fn(), createButton: { current: trigger as object | null },
    onPreview: (work: typeof receipt.work, button: object) => openWorkPreview(work.id, button, work.title),
    onSelect: vi.fn(), captureWorkNavigation, canAdd: true, groupId: undefined,
    isCurrentAudience: (): boolean => scope.controller.current.current.botId === "bot"
  }
  const creation = handler("BotWorkPanel.tsx", "BotWorkPanel", "create", scope)()
  expect(scope.client.works.create).toHaveBeenCalledOnce()
  const finish = async () => {
    result.resolve(receipt)
    await creation
    expect(scope.onSelect).not.toHaveBeenCalled()
    expect(scope.controller.refresh).toHaveBeenCalledOnce()
  }
  return { ...navigation, scope, finish }
}

function detailsOpenFixture() {
  const navigation = workspaceFixture()
  const selected = { id: "work", threadId: "original" }
  const thread = deferred<string>()
  const openBotWorkThreadChat = vi.fn()
  const setSaving = vi.fn()
  const opening = handler("BotWorkHeader.tsx", "BotWorkHeader", "openConversation", {
    work: selected, client: { conversations: {} }, current: () => true, saving: false, setMenuOpen: vi.fn(),
    captureWorkNavigation: navigation.captureWorkNavigation, setSaving, setError: vi.fn(),
    resolveBotWorkThreadForNavigation: () => thread.pending, openBotWorkThreadChat, threadContext: {}
  })()
  return { ...navigation, openBotWorkThreadChat, finish: async () => {
    thread.resolve(selected.threadId)
    await opening
    expect(setSaving.mock.calls).toEqual([[true], [false]])
  } }
}

async function skillFixture(target: NonNullable<QueuedMessage["botSkillTarget"]>) {
  const navigation = workspaceFixture()
  const { trigger, workspace, openWorkPreview, captureWorkNavigation } = navigation
  const destination = { botId: "bot", id: "skill-work", threadId: "skill-thread", audienceKey: "desktop", state: "active", title: "Skill work" }
  const onOpenWork = workspace("openWork", {
    works: { items: [destination], priority: [] }, detailTriggerRef: { current: trigger }, selectWork: vi.fn(), openWorkPreview
  })
  const release = deferred<void>()
  const skill = { name: "review", path: "/skills/review/SKILL.md" }
  const draft: QueuedMessage = { id: "skill-request", text: "Review this", botSkillTarget: target,
    botExplicitSkill: skill, created_at: new Date(1), updated_at: new Date(1) }
  let queued: QueuedMessage | undefined = draft
  const queue: Pick<ThreadActions, "getQueuedMessage" | "updateQueuedMessage" | "deleteQueuedMessage"> = {
    getQueuedMessage: () => queued,
    updateQueuedMessage: (_id, update, done) => {
      if (queued) queued = { ...queued, ...update }
      done?.(null)
    },
    deleteQueuedMessage: (_id, done) => { queued = undefined; done?.(null) }
  }
  const create = vi.fn(async () => {
    await release.pending
    return { work: destination, task: { workId: destination.id, origin: { kind: "user", explicitSkill: skill } } }
  })
  const send = vi.fn(async (input: SendBotMessageInput) => {
    await release.pending
    return { ...input, threadId: destination.threadId, origin: { kind: "user", explicitSkill: input.explicitSkill } }
  })
  const dispatchSkill = handler("BotConversation.tsx", "BotConversation", "dispatchSkill", {
    useCallback: (fn: unknown) => fn, mounted: { current: true }, bot: { id: destination.botId, threadId: "main" },
    client: { works: { create, get: async () => destination }, send }, queue, sender: { sending: new Set() },
    setSendingRevision: vi.fn(), setError: vi.fn(), validateSkill: async () => true,
    BotDraftSender, botWorkClient, getQueuedBotWorkCreationInput, captureWorkNavigation, onOpenWork
  })
  const sending = dispatchSkill(draft)
  const dispatch = target.kind === "create" ? create : send
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  return { ...navigation, finish: async () => {
    release.resolve()
    await sending
    expect(queued).toBeUndefined()
    expect(dispatch).toHaveBeenCalledOnce()
  } }
}

describe("task creation and skill assignment keep the main Bot chat", () => {
  it.each([
    { mainView: "bots", showCustomizeView: false, previews: true },
    { mainView: "bots", showCustomizeView: true, previews: false },
    { mainView: "thread", showCustomizeView: false, previews: false }
  ])("refreshes a created task on $mainView with settings open=$showCustomizeView", async (arrival) => {
    const { appState, scope, setWorkPreview, finish } = creationFixture()
    appState.mainView = arrival.mainView
    appState.showCustomizeView = arrival.showCustomizeView
    await finish()

    if (arrival.previews) {
      expect(setWorkPreview).toHaveBeenCalledExactlyOnceWith({
        hostId: "local", botId: "bot", workId: "created", title: "新任务"
      })
    } else {
      expect(setWorkPreview).not.toHaveBeenCalled()
    }
    expect(scope.setEditing).toHaveBeenCalledWith(false)
  })

  it("settles a late creation without replacing another task preview", async () => {
    const fixture = creationFixture()
    fixture.openWorkPreview("existing", fixture.trigger, "已有任务")
    await fixture.finish()
    expect(fixture.preview.current?.workId).toBe("existing")
    expect(fixture.setWorkPreview).toHaveBeenCalledOnce()
    expect(fixture.scope.setEditing).toHaveBeenCalledWith(false)
  })

  it("does not reopen the preview after the user dismisses another task", async () => {
    const fixture = creationFixture()
    fixture.openWorkPreview("existing", fixture.trigger, "已有任务")
    fixture.closePreview()
    await fixture.finish()
    expect(fixture.preview.current).toBeNull()
    expect(fixture.setWorkPreview.mock.calls.map(([value]) => value?.workId)).toEqual(["existing", undefined])
  })

  it("preserves opening the original chat while a creation settles", async () => {
    const fixture = creationFixture()
    fixture.openWorkPreview("existing", fixture.trigger, "已有任务")
    const finishOpening = fixture.openOriginalChat()
    await fixture.finish()
    expect(fixture.preview.current?.workId).toBe("existing")
    await finishOpening()
  })

  it("preserves opening an approval while a manual creation settles", async () => {
    const fixture = creationFixture()
    const finishOpening = fixture.openApproval()
    await fixture.finish()
    expect(fixture.setWorkPreview).not.toHaveBeenCalled()
    await finishOpening()
  })

  it("does not navigate through an unmounted task panel", async () => {
    const fixture = creationFixture()
    fixture.scope.createButton.current = null
    await fixture.finish()
    expect(fixture.setWorkPreview).not.toHaveBeenCalled()
  })

  it("does not apply another Bot's late creation to the current Bot", async () => {
    const fixture = creationFixture()
    fixture.scope.controller.current.current.botId = "another-bot"
    await fixture.finish()
    expect(fixture.setWorkPreview).not.toHaveBeenCalled()
    expect(fixture.scope.setEditing).not.toHaveBeenCalled()
  })

  it("previews an existing or newly assigned desktop work without selecting its conversation", () => {
    const n = navigation()
    n.openWork("existing")
    n.openWork("new-work-not-yet-in-directory")
    expect(n.openWorkPreview.mock.calls).toEqual([
      ["existing", n.trigger, "已有任务"], ["new-work-not-yet-in-directory", n.trigger, "任务"]
    ])
    expect(n.selectWork).not.toHaveBeenCalled()
    const source = readFileSync(new URL("../../components/bots/BotsWorkspace.tsx", import.meta.url), "utf8")
    expect(source).toMatch(/onOpenWork=\{openWork\}\s+captureWorkNavigation=\{captureWorkNavigation\}/)
    expect(source).toMatch(/onSelect=\{selectWork\}/)
    expect(source).toMatch(/onOpenWorkConversation=\{selectWork\}/)
  })

  it("preserves channel, explicit task resource and return navigation", () => {
    const n = navigation()
    n.openWork("channel")
    n.openWork(null)
    expect(n.selectWork.mock.calls).toEqual([["channel"], [null]])
    expect(n.openWorkPreview).not.toHaveBeenCalled()
    const resource = navigation(false)
    resource.openWork("existing")
    expect(resource.selectWork).toHaveBeenCalledExactlyOnceWith("existing")
    expect(resource.openWorkPreview).not.toHaveBeenCalled()
  })
})

describe("opening the original conversation from task details", () => {
  it("opens the original conversation when navigation is unchanged", async () => {
    const fixture = detailsOpenFixture()
    await fixture.finish()
    expect(fixture.openBotWorkThreadChat).toHaveBeenCalledExactlyOnceWith({}, "original")
  })

  it("keeps Settings open when the original conversation resolves", async () => {
    const fixture = detailsOpenFixture()
    fixture.appState.showCustomizeView = true
    await fixture.finish()
    expect(fixture.openBotWorkThreadChat).not.toHaveBeenCalled()
  })

  it("keeps the current view when the task details were closed", async () => {
    const fixture = detailsOpenFixture()
    fixture.setDetailOpen(false)
    await fixture.finish()
    expect(fixture.openBotWorkThreadChat).not.toHaveBeenCalled()
  })
})

describe.each([
  { kind: "create", title: "Skill work", path: "" },
  { kind: "work", workId: "skill-work" }
] as const)("skill assignment to $kind", target => {
  it("opens the destination on acknowledgement while navigation is unchanged", async () => {
    const fixture = await skillFixture(target)
    await fixture.finish()
    expect(fixture.preview.current?.workId).toBe("skill-work")
  })

  it.each(["files", "computer"] as const)("keeps the %s tab when the assignment is acknowledged", async tab => {
    const fixture = await skillFixture(target)
    fixture.setDetailTab(tab)
    await fixture.finish()
    expect(fixture.view.detailTab).toBe(tab)
    expect(fixture.setWorkPreview).not.toHaveBeenCalled()
  })

  it.each(["preview", "dismissed preview", "original chat", "approval"] as const)(
    "settles the assignment while preserving the newer %s choice", async choice => {
      const fixture = await skillFixture(target)
      if (choice !== "approval") fixture.openWorkPreview("existing", fixture.trigger, "已有任务")
      if (choice === "dismissed preview") fixture.closePreview()
      const finishOpening = choice === "approval" ? fixture.openApproval() :
        choice === "original chat" ? fixture.openOriginalChat() : undefined
      await fixture.finish()
      expect(fixture.preview.current?.workId).toBe(
        choice === "preview" || choice === "original chat" ? "existing" : undefined)
      await finishOpening?.()
    }
  )
})
