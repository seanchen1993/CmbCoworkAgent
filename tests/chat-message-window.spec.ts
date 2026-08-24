import assert from "node:assert/strict"
import {
  createPrependAnchoredChatMessageWindow,
  createTailChatMessageWindow,
  isTailChatMessageWindow,
  reconcileChatMessageWindow,
  revealChatMessageIndex,
  shiftChatMessageWindow
} from "../src/renderer/src/lib/chat-message-window"
import {
  createChatSearchMatcher,
  findChatSearchMatches
} from "../src/renderer/src/lib/chat-search-matches"
import { createChatMessageProjector } from "../src/renderer/src/lib/chat-message-projection"
import {
  deriveChatMessageWindowRows,
  findNextVisibleChatMessageIndex,
  findPreviousVisibleChatMessageIndex,
  mergeVisibleChatMessageIndexes
} from "../src/renderer/src/lib/chat-visible-index"
import type { Message } from "../src/renderer/src/types"

const tail = createTailChatMessageWindow(10_000)
assert.deepEqual(tail, { startIndex: 9_760, endIndex: 10_000 })
assert.equal(isTailChatMessageWindow(tail, 10_000), true)

const older = shiftChatMessageWindow(tail, 10_000, "older")
assert.deepEqual(older, { startIndex: 9_680, endIndex: 9_920 })
assert.equal(older.endIndex - older.startIndex, 240)

const newer = shiftChatMessageWindow(older, 10_000, "newer")
assert.deepEqual(newer, tail)

const revealed = revealChatMessageIndex(tail, 123, 10_000)
assert.equal(revealed.endIndex - revealed.startIndex, 240)
assert.ok(revealed.startIndex <= 123 && revealed.endIndex > 123)

assert.deepEqual(reconcileChatMessageWindow(older, 10_001, false), older)
assert.deepEqual(reconcileChatMessageWindow(tail, 10_001, true), {
  startIndex: 9_761,
  endIndex: 10_001
})
assert.deepEqual(createPrependAnchoredChatMessageWindow(500, 10_500), {
  startIndex: 261,
  endIndex: 501
})

assert.deepEqual(
  findChatSearchMatches(
    [
      { messageId: "m1", text: "Alpha alpha" },
      { messageId: "m2", text: "beta ALPHA" }
    ],
    "alpha"
  ),
  [
    { messageId: "m1", occurrenceIndex: 0 },
    { messageId: "m1", occurrenceIndex: 1 },
    { messageId: "m2", occurrenceIndex: 0 }
  ]
)

const baselineTarget: Message[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `stable-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: `stable content ${index}`,
  created_at: new Date(index)
}))
let stablePrefixReads = 0
const baseline = new Proxy(baselineTarget, {
  get(target, property, receiver) {
    if (typeof property === "string" && /^\d+$/.test(property)) stablePrefixReads += 1
    return Reflect.get(target, property, receiver)
  }
})
const projectMessages = createChatMessageProjector()
const firstProjection = projectMessages(
  baseline,
  [
    {
      id: "live-tail",
      role: "assistant",
      content: "a",
      created_at: new Date(10_000)
    }
  ],
  undefined
)
stablePrefixReads = 0
const tokenProjection = projectMessages(
  baseline,
  [
    {
      id: "live-tail",
      role: "assistant",
      content: "ab",
      created_at: new Date(10_000)
    }
  ],
  undefined
)
assert.equal(tokenProjection.messages, firstProjection.messages)
assert.equal(tokenProjection.indexById, firstProjection.indexById)
assert.equal(tokenProjection.structureVersion, firstProjection.structureVersion)
assert.ok(tokenProjection.contentVersion > firstProjection.contentVersion)
assert.equal(tokenProjection.messages.at(-1)?.content, "ab")
assert.equal(stablePrefixReads, 0, "content-only token frames must not walk the stable prefix")

const mutableBaseline = baselineTarget.slice()
const projectMutableBaseline = createChatMessageProjector()
const mutableBaselineInitial = projectMutableBaseline(mutableBaseline, [], undefined, 0)
const mutableBaselineValues = mutableBaseline.slice(0, mutableBaseline.length - 1)
for (let index = 0; index < mutableBaseline.length - 1; index += 1) {
  Object.defineProperty(mutableBaseline, index, {
    configurable: true,
    get(): never {
      throw new Error(`scheduler baseline update read stable index ${index}`)
    },
    set(value: Message): void {
      mutableBaselineValues[index] = value
    }
  })
}
mutableBaseline[mutableBaseline.length - 1] = {
  ...mutableBaseline.at(-1)!,
  content: "scheduler tail token"
}
const mutableBaselineToken = projectMutableBaseline(mutableBaseline, [], undefined, 1)
assert.equal(mutableBaselineToken.messages, mutableBaselineInitial.messages)
assert.equal(mutableBaselineToken.messages.at(-1)?.content, "scheduler tail token")
assert.ok(mutableBaselineToken.contentVersion > mutableBaselineInitial.contentVersion)

let windowMessageReads = 0
const windowMessageProxy = new Proxy(baselineTarget, {
  get(target, property, receiver) {
    if (typeof property === "string" && /^\d+$/.test(property)) windowMessageReads += 1
    return Reflect.get(target, property, receiver)
  }
})
const allVisibleIndexes = Array.from({ length: 10_000 }, (_, index) => index)
const boundedRows = deriveChatMessageWindowRows(
  windowMessageProxy,
  9_760,
  10_000,
  allVisibleIndexes,
  new Set(allVisibleIndexes),
  new Map(),
  9_998,
  []
)
assert.equal(boundedRows.length, 240)
assert.ok(
  windowMessageReads <= 242,
  `window derivation read ${windowMessageReads} rows instead of a bounded window`
)

const dynamicVisibilityTarget = new Map<number, boolean>(
  Array.from({ length: 2_000 }, (_, index) => [8_000 + index, true] as const)
)
const dynamicVisibilityWithoutIteration = new Proxy(dynamicVisibilityTarget, {
  get(target, property) {
    if (property === Symbol.iterator || property === "entries") {
      throw new Error("visible boundary lookup iterated the full current turn")
    }
    const value = Reflect.get(target, property, target) as unknown
    return typeof value === "function" ? value.bind(target) : value
  }
})
const orderedDynamicVisibleIndexes = Array.from({ length: 2_000 }, (_, index) => 8_000 + index)
assert.equal(
  findPreviousVisibleChatMessageIndex(
    10_000,
    allVisibleIndexes,
    dynamicVisibilityWithoutIteration,
    orderedDynamicVisibleIndexes
  ),
  9_999
)
assert.equal(
  findNextVisibleChatMessageIndex(
    9_900,
    allVisibleIndexes,
    dynamicVisibilityWithoutIteration,
    orderedDynamicVisibleIndexes
  ),
  9_900
)

assert.deepEqual(
  mergeVisibleChatMessageIndexes(
    [0, 1, 2, 5],
    new Map([
      [1, false],
      [3, true],
      [5, true]
    ]),
    [3, 5]
  ),
  [0, 2, 3, 5]
)

let stableSearchDocumentReads = 0
const stableSearchDocuments = new Proxy(
  Array.from({ length: 10_000 }, (_, index) => ({
    messageId: `search-${index}`,
    text: index === 123 ? "needle" : "stable",
    sortIndex: index
  })),
  {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) {
        stableSearchDocumentReads += 1
      }
      return Reflect.get(target, property, receiver)
    }
  }
)
const matchSearchCorpus = createChatSearchMatcher()
const initialSearchMatches = matchSearchCorpus(
  {
    stableDocuments: stableSearchDocuments,
    dynamicDocuments: [{ messageId: "search-live", text: "", sortIndex: 10_000 }],
    dynamicMessageIds: new Set(["search-live"])
  },
  "needle"
)
assert.equal(initialSearchMatches.length, 1)
stableSearchDocumentReads = 0
const streamingSearchMatches = matchSearchCorpus(
  {
    stableDocuments: stableSearchDocuments,
    dynamicDocuments: [{ messageId: "search-live", text: "needle", sortIndex: 10_000 }],
    dynamicMessageIds: new Set(["search-live"])
  },
  "needle"
)
assert.equal(streamingSearchMatches.length, 2)
assert.equal(
  stableSearchDocumentReads,
  0,
  "streaming search must reuse matches for stable history"
)

console.log("chat message window tests passed")
