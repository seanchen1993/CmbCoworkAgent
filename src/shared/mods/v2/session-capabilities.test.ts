import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { SESSION_CAPABILITIES as runtime } from "../../../main/mods/v2/session"
import { SESSION_CAPABILITIES as basicRuntime } from "../../../main/mods/v2/basic-sdk"
import { FILE_CAPABILITIES as fileRuntime } from "../../../main/mods/v2/file-access"
import {
  SESSION_CAPABILITIES,
  BASIC_SESSION_CAPABILITIES,
  FILE_CAPABILITIES
} from "./session-capabilities"

it("preserves the runtime exports and exact pre-extraction permission list and order", () => {
  expect(runtime).toBe(SESSION_CAPABILITIES)
  expect(basicRuntime).toBe(BASIC_SESSION_CAPABILITIES)
  expect(fileRuntime).toBe(FILE_CAPABILITIES)
  expect(runtime).toHaveLength(100)
  expect(createHash("sha256").update(JSON.stringify(runtime)).digest("hex")).toBe(
    "032da279d794b19da3b1b516a13c4b8d6c89ca8f54475b7a4b14b2252296ce35"
  )
})
