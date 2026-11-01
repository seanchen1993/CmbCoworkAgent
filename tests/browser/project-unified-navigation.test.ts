import { expect, it } from "vitest"
import type { Page } from "playwright"
import { allowCreatorWorkspaceInteraction, openUnifiedProjectList } from "../support/project-unified-native-journey"

it("restores creator dismissal after delivery navigation removes it between project trials", async () => {
  const handlers = new Map<object, () => Promise<void>>()
  const locators = new Map<string, object>()
  let guideRegistrations = 0
  let creatorVisible = true
  let projectClicks = 0
  const getByRole = (_role: string, options: { name: string }) => {
    const name = options.name
    if (!locators.has(name)) locators.set(name, {
      getByRole,
      first() { return this },
      async isVisible() { return name === "返回会话" ? false : true },
      async waitFor() { return undefined },
      async click() {
        if (name === "Close") creatorVisible = false
        if (name === "项目模式") {
          const creator = locators.get("插件创作工作区")!
          if (creatorVisible) await handlers.get(creator)?.()
          expect(creatorVisible, "creator modal still hides the project tab").toBe(false)
          projectClicks++
        }
      }
    })
    return locators.get(name)!
  }
  const page = {
    getByRole,
    async removeLocatorHandler(locator: object) { handlers.delete(locator) },
    async addLocatorHandler(locator: object, callback: () => Promise<void>) {
      if (locator === locators.get("项目模式使用引导")) guideRegistrations++
      handlers.set(locator, callback)
    }
  } as unknown as Page
  await openUnifiedProjectList(page)
  // The first trial returns to the author UI, where the creator dialog is intentionally used.
  await allowCreatorWorkspaceInteraction(page)
  expect(handlers.has(locators.get("插件创作工作区")!)).toBe(false)
  creatorVisible = true
  await openUnifiedProjectList(page)
  expect(projectClicks).toBe(2)
  expect(guideRegistrations).toBe(1)
  await allowCreatorWorkspaceInteraction(page)
  expect(handlers.has(locators.get("插件创作工作区")!)).toBe(false)
})
