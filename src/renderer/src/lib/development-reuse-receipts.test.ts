import { describe, expect, it } from "vitest"
import type { AuthoringDocument } from "../../../shared/mods/authoring"
import {
  getReuseReceipt,
  readReuseSelection,
  rememberReuseSelection,
  reuseReceiptKey
} from "../components/customize/development-reuse-receipts"

const selection = () => ({
  document: {
    id: "draft",
    workspace: "c:/owned",
    currentRevision: 1,
    source: { digest: "a".repeat(64), files: [] }
  } as unknown as AuthoringDocument,
  origin: { id: "dev", revision: 2, digest: "a".repeat(64) }
})
describe("process-local reuse observations", () => {
  it("binds exact scope and source tuples without transferring observations", () => {
    const source = selection(),
      key = reuseReceiptKey("thread", source)
    getReuseReceipt(key)!.set("created", "owned-target")
    expect(getReuseReceipt(key)!.data.created).toBe("owned-target")
    for (const changed of [
      { ...source, origin: { ...source.origin, revision: 3 } },
      { ...source, document: { ...source.document, workspace: "other" } },
      { ...source, document: { ...source.document, currentRevision: 2 } }
    ])
      expect(getReuseReceipt(reuseReceiptKey("thread", changed))!.data.created).toBeNull()
    expect(getReuseReceipt(reuseReceiptKey("other-thread", source))!.data.created).toBeNull()
  })
  it("keeps bounded selections as independent data and allows explicit close", () => {
    const source = selection()
    rememberReuseSelection("scope", source)
    source.origin.revision = 99
    const first = readReuseSelection("scope")!
    expect(first.origin.revision).toBe(2)
    first.origin.revision = 100
    expect(readReuseSelection("scope")!.origin.revision).toBe(2)
    for (let index = 0; index < 16; index++) rememberReuseSelection(`scope-${index}`, selection())
    expect(readReuseSelection("scope")).toBeNull()
    rememberReuseSelection("scope-15", null)
    expect(readReuseSelection("scope-15")).toBeNull()
  })
  it("does not evict in-flight mutations to make space for more mutations", () => {
    const entries = Array.from({ length: 16 }, (_, index) => {
      const receipt = getReuseReceipt(`busy-${index}`)!
      receipt.set("busy", true)
      return receipt
    })
    try {
      expect(getReuseReceipt("overflow")).toBeNull()
    } finally {
      for (const entry of entries) entry.set("busy", false)
    }
    expect(getReuseReceipt("overflow")!.data.busy).toBe(false)
  })
  it("does not evict mounted receipts and resumes capacity after unmount", () => {
    const entries = Array.from({ length: 16 }, (_, index) => {
      const receipt = getReuseReceipt(`mounted-${index}`)!
      return { receipt, unsubscribe: receipt.subscribe(() => {}) }
    })
    try {
      expect(getReuseReceipt("mounted-overflow")).toBeNull()
      expect(getReuseReceipt("mounted-0")).toBe(entries[0].receipt)
    } finally {
      for (const entry of entries) entry.unsubscribe()
    }
    expect(getReuseReceipt("mounted-overflow")).not.toBeNull()
  })
})
