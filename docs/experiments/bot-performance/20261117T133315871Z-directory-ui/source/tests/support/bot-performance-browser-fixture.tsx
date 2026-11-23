/** Real production hooks/panel with an instrumented metadata transport, not a model fixture. */
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { useBots } from "../../src/renderer/src/components/bots/use-bots"
import { useBotWorks } from "../../src/renderer/src/components/bots/use-bot-works"
import { BotWorkPanel } from "../../src/renderer/src/components/bots/BotWorkPanel"
import {
  FeatureRow,
  useBotFeatureTasks
} from "../../src/renderer/src/components/bots/BotFeaturePanel"
import type { BotClient } from "../../src/shared/bots/contracts"
import type { BotWorkItem } from "../../src/shared/bots/work"

const rows = Array.from({ length: 2000 }, (_, i) => ({
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
const listeners = new Set<(event: any) => void>()
const state: any = {
  revision: 1,
  latency: 10,
  rows,
  counts: {},
  inFlight: 0,
  peak: 0,
  maxBatch: 0,
  calls: [],
  hold: false,
  releases: []
}
async function request<T>(name: string, body: () => T): Promise<T> {
  state.lastActivityAt = performance.now()
  state.counts[name] = (state.counts[name] ?? 0) + 1
  state.inFlight++
  state.peak = Math.max(state.peak, state.inFlight)
  state.calls.push({ name, at: performance.now() })
  try {
    if (state.hold) await new Promise<void>((resolve) => state.releases.push(resolve))
    else if (state.latency) await new Promise((resolve) => setTimeout(resolve, state.latency))
    return structuredClone(body())
  } finally {
    state.inFlight--
    state.lastActivityAt = performance.now()
  }
}
const client = {
  hostId: "local",
  subscribe(fn: any) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  snapshot() {
    return request("snapshot", () => ({
      host: { id: "local" },
      revision: state.revision,
      bots: [],
      tasks: [],
      groups: []
    }))
  },
  works: {
    list(_bot: string, cursor?: string, query = "") {
      return request("list", () => {
        const matches = rows.filter((r) => r.title.includes(query))
        const at = Number(cursor ?? 0)
        return {
          items: matches.slice(at, at + 40),
          priority: [],
          nextCursor: matches.length > at + 40 ? String(at + 40) : null
        }
      })
    },
    get(_bot: string, id: string) {
      return request("get", () => rows.find((r) => r.id === id))
    },
    summaries(_bot: string, ids: string[]) {
      state.maxBatch = Math.max(state.maxBatch, ids.length)
      return request("summaries", () => ids.map((id) => rows.find((r) => r.id === id)!))
    }
  }
} as unknown as BotClient
state.emit = (detail: any = {}) => {
  state.lastActivityAt = performance.now()
  state.revision++
  for (const listener of listeners)
    listener({ hostId: "local", revision: state.revision, workChanges: [], ...detail })
}
state.reset = () => {
  state.counts = {}
  state.calls = []
  state.peak = state.inFlight
  state.maxBatch = 0
  state.lastActivityAt = performance.now()
}
function Fixture() {
  const [selected, setSelected] = useState<string | null>(null)
  const { snapshot } = useBots(client)
  const controller = useBotWorks(client, "a", selected, snapshot?.revision ?? 0)
  Object.assign(state, {
    loaded: controller.items.length,
    loading: controller.loading,
    revisionShown: snapshot?.revision ?? 0,
    more: controller.more,
    refresh: controller.refresh,
    setQuery: controller.setQuery,
    renderedItems: controller.items
  })
  ;(window as any).botPerf = state
  return (
    <BotWorkPanel
      client={client}
      botId="a"
      controller={controller}
      selected={controller.selected}
      onSelect={setSelected}
      disabled={false}
    />
  )
}
;(window as any).api = { threads: { get: async () => ({ metadata: {} }) } }
const root = createRoot(document.getElementById("root")!)
const feature = {
  kind: "feature" as const,
  id: "follow",
  projectId: "p",
  slug: "fixture",
  projectName: "Synthetic project",
  title: "Performance Feature",
  phase: "following" as const,
  state: "active" as const,
  version: 1,
  updatedAt: 1
}
const featureClient = {
  ...client,
  features: {
    list() { throw new Error("Production feature list must use cursor paging") },
    page(_bot: string, _group?: string, input: any = {}) {
      return request("feature_list", () => {
        const all = Array.from({ length: 130 }, (_, index) => ({ ...feature, id: index ? `follow-${index}` : "follow", slug: `fixture-${index}`, title: index ? `Feature item ${index}` : feature.title }))
        const rows = all.filter(row => row.title.includes(input.query ?? ""))
        const at = Number(input.cursor ?? 0)
        return { items: rows.slice(at, at + 40), priority: [], refreshed: all.filter(row => input.refreshIds?.includes(row.id)), nextCursor: at + 40 < rows.length ? String(at + 40) : null }
      })
    },
    detail() {
      return request("feature_detail", () => ({ ...feature, sessions: [] }))
    }
  }
} as unknown as BotClient
function FeatureFixture() {
  const [query, setQuery] = useState("")
  const data = useBotFeatureTasks({ client: featureClient, botId: "a", query })
  Object.assign(state, { featureData: data, featureQuery: setQuery })
  return (
    <>
      {data.items.map((item) => (
        <FeatureRow
          key={item.id}
          feature={item}
          api={featureClient.features!}
          botId="a"
          revision={data.revision}
          refresh={data.refresh}
        />
      ))}
    </>
  )
}
state.showFeature = () => root.render(<FeatureFixture />)
root.render(<Fixture />)
