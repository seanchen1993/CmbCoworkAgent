import { describe, expect, it } from "vitest"
import { isSupportedWorkspaceMentionFilePath } from "../renderer/src/features/mentions/useAtFileMentions"

describe("@file mention support", () => {
  it("supports Vue single-file components in nested workspace paths", () => {
    expect(isSupportedWorkspaceMentionFilePath("/apps/web.v2/src/components/App.vue")).toBe(true)
  })

  it("keeps rejecting binary workspace files", () => {
    expect(isSupportedWorkspaceMentionFilePath("/assets/logo.png")).toBe(false)
  })
})
