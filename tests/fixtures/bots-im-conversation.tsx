/** Synthetic transport; render the production workspace and group conversation components. */
import React from "react"
import { createRoot } from "react-dom/client"
import { BotsWorkspace } from "../../src/renderer/src/components/bots/BotsWorkspace"
import { useBotViewStore } from "../../src/renderer/src/components/bots/view-store"

const bot = {
  id: "bot",
  hostId: "local",
  threadId: "private",
  name: "招乎T",
  color: "#ed2040",
  shape: "drop",
  instructions: "协助团队梳理工作、整理信息。",
  archived: false,
  deleting: false,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  modelRef: null
}
const activity = (id: string, preview: string) => ({
  kind: "im",
  id,
  version: 2,
  unread: true,
  updatedAt: 100,
  preview
})
const groups = [
  {
    id: "group-a",
    botId: bot.id,
    bindingId: "binding-a",
    title: "产品协作群",
    state: "active",
    connected: true,
    activity: activity("group-a", "已整理好本周的项目进展。")
  },
  {
    id: "group-b",
    botId: bot.id,
    bindingId: "binding-b",
    title: "体验优化小组",
    state: "active",
    connected: false,
    activity: activity("group-b", "三个界面问题，已整理为改进清单。")
  }
]
const removedBindings = new Set<string>()
const t = new Date("2026-10-27T14:30:00+08:00").getTime()
const entry = (id: string, text: string, kind = "bot", extra = {}) => ({
  id,
  text,
  kind,
  senderId: kind === "bot" ? "Bot" : "opaque-member",
  state: kind === "bot" ? "accepted" : "completed",
  createdAt: t + Number(id.replace(/\D/g, "")) * 60000,
  replyToMessageId: null,
  ...extra
})
const latest = [
  entry("a1", "整理一下本周的项目进展，列出当前进度和需要大家确认的事项。", "user"),
  entry(
    "a2",
    "已整理好本周的项目进展。\n\n- **IM 接入**：群内绑定和消息收发已打通。\n- **会话体验**：群记录与私人对话分开显示。\n- **待确认**：演示时间，以及每项工作的负责人。"
  ),
  entry("a3", "把演示准备单独建个任务，后续在任务里继续细化。", "user"),
  entry("a4", "已创建「演示准备清单」，整理完成后会同步结果到群里。", "bot", { workId: "work-a" })
]
const work = {
  id: "work-a",
  botId: bot.id,
  threadId: "task-a",
  parentThreadId: "im-a",
  title: "演示准备清单",
  goal: "准备演示",
  state: "active",
  version: 1,
  source: { transport: "im", bindingId: "group-a" },
  executionState: "completed",
  activity: { kind: "work", id: "work-a", version: 1, unread: true },
  createdAt: t,
  updatedAt: t,
  conversation: { kind: "local", state: "linked" }
}
const f = ((window as any).fixture = {
  calls: [] as any[],
  reads: [] as any[],
  opened: [] as any[],
  manage: 0,
  hold: false,
  release: null as any,
  fail: false,
  groups,
  latest,
  work,
  bump: () => {}
})
const listeners = new Set<Function>()
let revision = 1
f.bump = () => {
  revision++
  for (const listener of listeners) listener({ revision })
}
const memories: any[] = [
  {
    id: "private",
    name: "私人偏好",
    content: "仅本人使用",
    scope: { kind: "private" },
    version: "1"
  },
  {
    id: "shared",
    name: "团队写作格式",
    content: "结论在前，保持简洁。",
    scope: { kind: "shared" },
    version: "1"
  },
  {
    id: "group-a",
    name: "演示约定",
    content: "每周五下午演示。",
    scope: { kind: "group", groupId: "group-a" },
    version: "1"
  },
  {
    id: "group-b",
    name: "体验组约定",
    content: "每周三评审。",
    scope: { kind: "group", groupId: "group-b" },
    version: "1"
  }
]
const client = {
  browserPreview: async (scope: string) => {
    f.calls.push(["browser", scope])
    return { pages: [], pageId: null, image: null, generation: 1, control: "bot" }
  },
  hostId: "local",
  snapshot: async () => ({
    host: { id: "local", kind: "local", name: "本机", capabilities: {} },
    bots: [bot],
    groups: [],
    imConversations: groups.map((g) => ({ ...g, activity: { ...g.activity } })),
    tasks: [],
    activities: [
      { kind: "bot", id: "bot", version: 1, unread: true, updatedAt: 1, preview: "私人主对话" }
    ],
    workActivity: [],
    schedules: [],
    revision
  }),
  subscribe: (fn: Function) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  markRead: async (...args: any[]) => {
    f.reads.push(args)
  },
  open: async () => {},
  requestReceipts: async () => [],
  listMemory: async (_bot: string, groupId?: string) =>
    memories.filter(
      (entry) =>
        entry.scope.kind === "shared" ||
        (groupId ? entry.scope.groupId === groupId : entry.scope.kind === "private")
    ),
  writeMemory: async (_bot: string, input: any) => {
    const entry = { ...input, id: input.id ?? String(memories.length), version: "2" }
    const prior = memories.findIndex((entry) => entry.id === input.id)
    if (prior < 0) memories.push(entry)
    else memories[prior] = entry
    return entry
  },
  works: {
    list: async () => ({ items: [], priority: [], nextCursor: null }),
    get: async () => work,
    summaries: async () => [work],
    lifecycle: async ({ action }: { action: string }) => {
      work.state = action === "complete" ? "completed" : "active"
      work.version++
      f.bump()
      return { ...work }
    }
  },
  im: {
    conversationHistory: async (botId: string, id: string, before?: string) => {
      f.calls.push({ botId, id, before })
      if (f.hold) {
        f.hold = false
        await new Promise((resolve) => (f.release = resolve))
      }
      if (f.fail) throw Error("本地记录读取失败")
      return id === "group-b"
        ? { items: [entry("b1", "三个界面问题，已整理为改进清单。")], before: null }
        : before
          ? { items: [entry("a0", "早些时候：我们先明确本周的演示范围。", "user")], before: null }
          : { items: latest, before: "older-a" }
    },
    conversationWorks: async (_bot: string, id: string) => ({
      items: id === "group-a" ? [work] : [],
      priority: [],
      nextCursor: null
    }),
    status: async () => ({ connected: true, available: true }),
    list: async () => ({
      items: [
        {
          id: "binding-a",
          botId: "bot",
          kind: "group",
          state: "active",
          version: 1,
          conversationKey: "a",
          createdAt: new Date(t).toISOString()
        },
        ...["revoked", "expired"].map((state) => ({
          id: `binding-${state}`,
          botId: "bot",
          kind: "group",
          state,
          version: 2,
          peerLabel: state === "revoked" ? "已撤销测试群" : "已过期测试群",
          createdAt: new Date(t).toISOString(),
          expiresAt: new Date(t).toISOString()
        }))
      ].filter((binding) => !removedBindings.has(binding.id)),
      before: null
    }),
    remove: async (_botId: string, id: string) => {
      removedBindings.add(id)
    },
    history: async () => ({ items: [], before: null })
  }
}
;(window as any).api = {
  models: { getUserInfo: async () => null },
  threads: { get: async () => null },
  system: { getPlatform: async () => "darwin" }
}
;(window as any).electron = { onNotifyMsg: () => () => {} }
useBotViewStore
  .getState()
  .update("local", { selectedId: "bot", imConversationId: "group-a", detailOpen: true })
createRoot(document.getElementById("root")!).render(<BotsWorkspace client={client as any} />)
