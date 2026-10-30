import { describe, expect, it } from "vitest"
import type { BrowserScriptLibraryEntry } from "../../../shared/browser-types"
import { hasBrowserRecordingNameConflict } from "./browser-recording-name"

const entries = [
  { fileName: "first.spec.ts", displayName: "查询客户" },
  { fileName: "second.spec.ts", displayName: "Create Order" }
] as BrowserScriptLibraryEntry[]

describe("browser recording names", () => {
  it.each(["查询客户", " 查询客户 ", "create order", " CREATE ORDER "])(
    "rejects an existing save-as name: %s",
    (displayName) => {
      expect(hasBrowserRecordingNameConflict(entries, displayName)).toBe(true)
    }
  )

  it.each(["查询供应商", "Create Invoice", "", "   "])(
    "allows a new or incomplete name: %s",
    (displayName) => {
      expect(hasBrowserRecordingNameConflict(entries, displayName)).toBe(false)
    }
  )
})
