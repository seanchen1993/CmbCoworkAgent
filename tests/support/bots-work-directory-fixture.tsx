import { useState } from "react"
import { createRoot } from "react-dom/client"
import { useBotWorks } from "../../src/renderer/src/components/bots/use-bot-works"
import { BotWorkPanel } from "../../src/renderer/src/components/bots/BotWorkPanel"
import type { BotClient } from "../../src/shared/bots/contracts"
import type { BotWorkItem } from "../../src/shared/bots/work"

const rows = Array.from({ length: 45 }, (_, i) => ({
  id: `w${i}`,
  botId: "a",
  threadId: `t${i}`,
  parentThreadId: "main",
  title: `Work ${i}`,
  goal: "Fixture",
  audienceKey: "desktop",
  threadInitialized: true,
  state: "active",
  version: 1,
  createdAt: i + 1,
  updatedAt: i + 1,
  executionState: "completed",
  pendingPeers: 0,
  backgroundBusy: false
})) as BotWorkItem[]
const state: any = { rows, maxBatch: 0, calls: 0, inFlight: 0, maxInFlight: 0, hold: null }
const client = {
  hostId: "local",
  works: {
    async list(botId: string, cursor?: string, query = "") {
      state.calls++
      state.inFlight++
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
      try {
        const matching =
          botId === "a"
            ? rows
                .filter((r) => r.title.includes(query))
                .slice()
                .reverse()
            : []
        const offset = cursor ? Number(cursor) : 0
        return {
          items: structuredClone(matching.slice(offset, offset + 40)),
          priority: [],
          nextCursor: matching.length > offset + 40 ? String(offset + 40) : null
        }
      } finally {
        state.inFlight--
      }
    },
    async get(botId: string, id: string) {
      if (state.hold === id)
        await new Promise<void>((resolve, reject) => {
          state.release = resolve
          state.reject = reject
        })
      const row = rows.find((r) => r.id === id && r.botId === botId)
      if (!row) throw new Error("Missing fixture work")
      return structuredClone(row)
    },
    async summaries(botId: string, ids: string[]) {
      state.maxBatch = Math.max(state.maxBatch, ids.length)
      return structuredClone(rows.filter((r) => r.botId === botId && ids.includes(r.id)))
    }
  }
} as unknown as BotClient
function Fixture() {
  const [botId, setBot] = useState("a"),
    [selectedId, setSelected] = useState<string | null>(null),
    [revision, setRevision] = useState(1)
  const controller = useBotWorks(client, botId, selectedId, revision)
  Object.assign(state, {
    botId,
    selectedId,
    selected: controller.selected,
    loading: controller.loading,
    error: controller.error,
    refresh: () => setRevision((v) => v + 1),
    select: setSelected,
    switchBot: setBot,
    query: controller.setQuery
  })
  ;(window as any).m05Directory = state
  return (
    <>
      <output data-selected={controller.selected?.id ?? ""}>
        {controller.selected?.title ?? "none"}
      </output>
      <BotWorkPanel
        client={client}
        botId={botId}
        controller={controller}
        selected={controller.selected}
        onSelect={setSelected}
        disabled={false}
      />
    </>
  )
}
createRoot(document.getElementById("root")!).render(<Fixture />)
