/**
 * Run: npx tsx tests/stream-panel-message-window.spec.ts
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildStreamPanelMessageWindow,
  createStreamPanelMessageProjector,
  shiftStreamPanelMessageWindowEnd,
  STREAM_PANEL_MESSAGE_WINDOW_SHIFT,
  STREAM_PANEL_MESSAGE_WINDOW_SIZE
} from "../src/renderer/src/lib/stream-panel-message-window"
import { createSubagentPanelTranscriptProjector } from "../src/renderer/src/lib/subagent-panel-transcript"
import type { Message } from "../src/renderer/src/types"

function message(index: number, content = `content-${index}`): Message {
  return {
    id: `message-${index}`,
    provider_source_id: `source-${index}`,
    provider_occurrence: 1,
    role: index % 3 === 0 ? "user" : "assistant",
    content,
    created_at: new Date(index)
  }
}

const history = Array.from({ length: 10_000 }, (_, index) => message(index))
let detachedWindowReads = 0
const guardedHistory = new Proxy(history, {
  get(target, property, receiver) {
    const index = typeof property === "string" && /^\d+$/.test(property) ? Number(property) : -1
    if (index >= 0 && index < target.length - STREAM_PANEL_MESSAGE_WINDOW_SIZE) {
      detachedWindowReads += 1
      throw new Error(`window read detached prefix index ${index}`)
    }
    return Reflect.get(target, property, receiver)
  }
})

const latestWindow = buildStreamPanelMessageWindow(guardedHistory, null)
assert.equal(latestWindow.start, 9_760)
assert.equal(latestWindow.end, 10_000)
assert.equal(latestWindow.messages.length, STREAM_PANEL_MESSAGE_WINDOW_SIZE)
assert.equal(detachedWindowReads, 0, "the default panel window must not read detached history")

const olderEnd = shiftStreamPanelMessageWindowEnd(
  latestWindow.end,
  history.length,
  "older"
)
assert.equal(olderEnd, 10_000 - STREAM_PANEL_MESSAGE_WINDOW_SHIFT)
const olderWindow = buildStreamPanelMessageWindow(history, olderEnd)
assert.equal(olderWindow.messages.length, STREAM_PANEL_MESSAGE_WINDOW_SIZE)
assert.equal(olderWindow.start, 9_680)
assert.equal(
  shiftStreamPanelMessageWindowEnd(olderWindow.end, history.length, "newer"),
  null,
  "the newer page after one overlapping shift is the live tail"
)

const projectMessages = createStreamPanelMessageProjector()
const initialProjection = projectMessages(history)
const nextHistory = history.slice()
nextHistory[nextHistory.length - 1] = {
  ...nextHistory.at(-1)!,
  content: "streamed token"
}
let stablePrefixReads = 0
const guardedNextHistory = new Proxy(nextHistory, {
  get(target, property, receiver) {
    const index = typeof property === "string" && /^\d+$/.test(property) ? Number(property) : -1
    if (index >= 0 && index < target.length - 32) {
      stablePrefixReads += 1
      throw new Error(`tail projection read stable prefix index ${index}`)
    }
    return Reflect.get(target, property, receiver)
  }
})
const tokenProjection = projectMessages(guardedNextHistory)
assert.equal(tokenProjection.messages, initialProjection.messages)
assert.equal(tokenProjection.structureVersion, initialProjection.structureVersion)
assert.ok(tokenProjection.contentVersion > initialProjection.contentVersion)
assert.equal(tokenProjection.messages.at(-1)?.content, "streamed token")
assert.equal(stablePrefixReads, 0, "a workflow token frame must only inspect its bounded tail")

const verifiedProjection = projectMessages(nextHistory, false)
assert.notEqual(verifiedProjection.messages, tokenProjection.messages)
assert.ok(verifiedProjection.structureVersion > tokenProjection.structureVersion)

const persistedPage = history.slice(0, 9_900)
const liveTail = history.slice(9_900)
const projectTranscript = createSubagentPanelTranscriptProjector()
let persistedPrefixReads = 0
const guardedPersistedPage = new Proxy(persistedPage, {
  get(target, property, receiver) {
    if (typeof property === "string" && /^\d+$/.test(property)) persistedPrefixReads += 1
    return Reflect.get(target, property, receiver)
  }
})
const initialTranscript = projectTranscript(guardedPersistedPage, liveTail, true)
persistedPrefixReads = 0
const nextLiveTail = liveTail.slice()
nextLiveTail[nextLiveTail.length - 1] = {
  ...nextLiveTail.at(-1)!,
  content: "subagent streamed token"
}
const allowedTailReplacementReads = new Set([0, 49, 98, 99])
let tailReplacementReads = 0
const guardedNextLiveTail = new Proxy(nextLiveTail, {
  get(target, property, receiver) {
    const index = typeof property === "string" && /^\d+$/.test(property) ? Number(property) : -1
    if (index >= 0) {
      tailReplacementReads += 1
      if (!allowedTailReplacementReads.has(index)) {
        throw new Error(`tail replacement read stable live prefix index ${index}`)
      }
    }
    return Reflect.get(target, property, receiver)
  }
})
const tokenTranscript = projectTranscript(guardedPersistedPage, guardedNextLiveTail, true)
assert.equal(tokenTranscript.messages, initialTranscript.messages)
assert.equal(tokenTranscript.structureVersion, initialTranscript.structureVersion)
assert.equal(tokenTranscript.messages.at(-1)?.content, "subagent streamed token")
assert.ok(
  tailReplacementReads <= allowedTailReplacementReads.size,
  `tail replacement performed ${tailReplacementReads} indexed reads`
)
assert.equal(persistedPrefixReads, 0, "a subagent token frame must not revisit the 9.9k page")

const projectMutableTranscript = createSubagentPanelTranscriptProjector()
const mutableLiveTail = liveTail.slice()
const mutableInitial = projectMutableTranscript(persistedPage, mutableLiveTail, true, 0)
const mutableStableValues = mutableLiveTail.slice(0, mutableLiveTail.length - 1)
for (let index = 0; index < mutableLiveTail.length - 1; index += 1) {
  Object.defineProperty(mutableLiveTail, index, {
    configurable: true,
    get(): never {
      throw new Error(`mutable transcript update read stable live index ${index}`)
    },
    set(value: Message): void {
      mutableStableValues[index] = value
    }
  })
}
mutableLiveTail[mutableLiveTail.length - 1] = {
  ...mutableLiveTail.at(-1)!,
  content: "same-array subagent token"
}
const mutableToken = projectMutableTranscript(persistedPage, mutableLiveTail, true, 1)
assert.equal(mutableToken.messages, mutableInitial.messages)
assert.equal(mutableToken.messages.at(-1)?.content, "same-array subagent token")
assert.ok(mutableToken.contentVersion > mutableInitial.contentVersion)

const appendedLiveTail = [...nextLiveTail, message(10_000)]
const allowedAppendReads = new Set([0, 49, 99, 100])
let appendReads = 0
const guardedAppend = new Proxy(appendedLiveTail, {
  get(target, property, receiver) {
    const index = typeof property === "string" && /^\d+$/.test(property) ? Number(property) : -1
    if (index >= 0) {
      appendReads += 1
      if (!allowedAppendReads.has(index)) {
        throw new Error(`append read stable live prefix index ${index}`)
      }
    }
    return Reflect.get(target, property, receiver)
  }
})
const appendedTranscript = projectTranscript(guardedPersistedPage, guardedAppend, true)
assert.equal(appendedTranscript.messages, tokenTranscript.messages)
assert.equal(appendedTranscript.messages.length, 10_001)
assert.equal(appendedTranscript.messages.at(-1)?.id, "message-10000")
assert.ok(appendReads <= allowedAppendReads.size, `append performed ${appendReads} indexed reads`)

const changedPersistedPage = persistedPage.slice()
changedPersistedPage[0] = { ...changedPersistedPage[0], content: "hydrated correction" }
const pageFallback = projectTranscript(changedPersistedPage, appendedLiveTail, true)
assert.notEqual(pageFallback.messages, appendedTranscript.messages)
assert.ok(pageFallback.structureVersion > appendedTranscript.structureVersion)
assert.equal(pageFallback.messages[0].content, "hydrated correction")

const reorderedLiveTail = appendedLiveTail.slice()
const last = reorderedLiveTail.at(-1)!
reorderedLiveTail[reorderedLiveTail.length - 1] = reorderedLiveTail.at(-2)!
reorderedLiveTail[reorderedLiveTail.length - 2] = last
const reorderFallback = projectTranscript(changedPersistedPage, reorderedLiveTail, true)
assert.notEqual(reorderFallback.messages, pageFallback.messages)
assert.ok(reorderFallback.structureVersion > pageFallback.structureVersion)

const exactTailAgain = reorderedLiveTail.slice()
exactTailAgain[exactTailAgain.length - 1] = {
  ...exactTailAgain.at(-1)!,
  content: "one more token"
}
const fastAgain = projectTranscript(changedPersistedPage, exactTailAgain, true)
assert.equal(fastAgain.messages, reorderFallback.messages)
const idleVerification = projectTranscript(changedPersistedPage, exactTailAgain, false)
assert.notEqual(idleVerification.messages, fastAgain.messages)
assert.ok(idleVerification.structureVersion > fastAgain.structureVersion)

const changedTailIdentity = exactTailAgain.slice()
changedTailIdentity[changedTailIdentity.length - 1] = {
  ...changedTailIdentity.at(-1)!,
  provider_source_id: "corrected-provider-identity"
}
const identityFallback = projectTranscript(changedPersistedPage, changedTailIdentity, true)
assert.notEqual(identityFallback.messages, idleVerification.messages)
assert.ok(identityFallback.structureVersion > idleVerification.structureVersion)

const replacementTail = changedTailIdentity.slice()
replacementTail[replacementTail.length - 1] = {
  ...replacementTail.at(-1)!,
  content: "authoritative completion",
  replaced_message_ids: ["provisional-live-row"]
}
const replacementFallback = projectTranscript(changedPersistedPage, replacementTail, true)
assert.notEqual(replacementFallback.messages, identityFallback.messages)
assert.ok(replacementFallback.structureVersion > identityFallback.structureVersion)

const projectCollision = createSubagentPanelTranscriptProjector()
const collisionBaseline = [
  {
    ...message(1),
    id: "canonical-row",
    provider_source_id: "shared-provider-row",
    provider_occurrence: 1,
    replaced_message_ids: ["legacy-row"]
  }
]
const emptyCollisionLive: Message[] = []
const collisionInitial = projectCollision(collisionBaseline, emptyCollisionLive, true)
const providerCollision = projectCollision(
  collisionBaseline,
  [
    {
      ...message(2),
      id: "provider-collision",
      provider_source_id: "shared-provider-row",
      provider_occurrence: 1
    }
  ],
  true
)
assert.notEqual(providerCollision.messages, collisionInitial.messages)
assert.ok(providerCollision.structureVersion > collisionInitial.structureVersion)

const projectAliasCollision = createSubagentPanelTranscriptProjector()
const aliasInitial = projectAliasCollision(collisionBaseline, emptyCollisionLive, true)
const aliasCollision = projectAliasCollision(
  collisionBaseline,
  [{ ...message(3), id: "legacy-row", provider_source_id: undefined }],
  true
)
assert.notEqual(aliasCollision.messages, aliasInitial.messages)
assert.ok(aliasCollision.structureVersion > aliasInitial.structureVersion)

for (const panelName of ["SubagentStreamPanel", "WorkflowAgentStreamPanel"]) {
  const panelSource = readFileSync(
    join(process.cwd(), `src/renderer/src/components/chat/${panelName}.tsx`),
    "utf8"
  )
  assert.match(panelSource, /buildStreamPanelMessageWindow\(fullMessages, messageWindowEnd\)/)
  assert.match(panelSource, /messages\.map\(\(message, index\) =>/)
  assert.doesNotMatch(
    panelSource,
    /fullMessages\.map\(/,
    `${panelName} must not mount or derive rows by mapping the full transcript`
  )
  assert.match(panelSource, /buildToolResultAssociations\(messages\)/)
  assert.match(panelSource, /buildMessageBubbleTimingMeta\(messages\)/)
  assert.match(panelSource, /buildVisibleMessageLayout\(messages,/)
  assert.match(panelSource, /前一页/)
  assert.match(panelSource, /后一页/)
  assert.match(panelSource, /最新/)
}

const subagentPanelSource = readFileSync(
  join(process.cwd(), "src/renderer/src/components/chat/SubagentStreamPanel.tsx"),
  "utf8"
)
assert.doesNotMatch(
  subagentPanelSource,
  /useThreadState\(/,
  "focused transcript tokens must not subscribe the panel to the complete ThreadState"
)
assert.match(subagentPanelSource, /useThreadStateSelector\(/)
assert.match(
  subagentPanelSource,
  /useMemo\(\s*\(\) => subagents\.find/,
  "the focused card lookup must run only when the subagent collection changes"
)

console.log("stream panel message window tests passed")
