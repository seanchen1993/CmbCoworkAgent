import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const rendererRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../renderer/src")

const uploaderProfileCallers = [
  "components/dashboard/DashboardView.tsx",
  "components/dashboard/panels/ProjectModePanel.tsx",
  "components/harness-board/HarnessBoardView.tsx",
  "components/customize/MarketPanel/MarketPanel.tsx"
]

describe("dashboard uploader profile callers", () => {
  it.each(uploaderProfileCallers)("keeps %s on the bounded userProfiles API", (relativePath) => {
    const source = readFileSync(resolve(rendererRoot, relativePath), "utf8")
    expect(source).toContain("dashboard.userProfiles(")
    expect(source).not.toContain("dashboard.queryAllUser(")
  })
})
