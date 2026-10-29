import { describe, expect, it, vi } from "vitest"
import { createNativeClosePrompt } from "./native-close-prompt"
import type { MessageBoxOptions } from "electron"

function fixture() {
  const prompt = createNativeClosePrompt()
  const context = {
    isAvailable: vi.fn(() => true),
    hasActiveRuns: vi.fn(() => false),
    hasTray: vi.fn(() => true),
    show: vi
      .fn<(options: MessageBoxOptions) => Promise<{ response: number }>>()
      .mockResolvedValue({ response: 0 }),
    minimize: vi.fn(),
    quit: vi.fn()
  }
  return { prompt, context }
}

describe("native close fallback", () => {
  it.each([0, 1, 2])("executes only the selected action %s", async (response) => {
    const { prompt, context } = fixture()
    context.show.mockResolvedValue({ response })
    await prompt.request(context)
    expect(context.quit).toHaveBeenCalledTimes(response === 1 ? 1 : 0)
    expect(context.minimize).toHaveBeenCalledTimes(response === 2 ? 1 : 0)
    expect(context.show.mock.calls[0][0]).toMatchObject({ defaultId: 0, cancelId: 0 })
  })

  it("reconfirms newly active work", async () => {
    const { prompt, context } = fixture()
    context.show.mockImplementationOnce(async () => {
      context.hasActiveRuns.mockReturnValue(true)
      return { response: 1 }
    })
    await prompt.request(context)
    expect(context.show).toHaveBeenCalledTimes(2)
    expect(context.show.mock.calls[1][0]).toMatchObject({
      message: "仍有任务正在运行，是否退出应用？"
    })
    expect(context.quit).not.toHaveBeenCalled()
  })

  it("does not hide the window after the tray disappears", async () => {
    const { prompt, context } = fixture()
    context.show.mockImplementationOnce(async () => {
      context.hasTray.mockReturnValue(false)
      return { response: 2 }
    })
    await prompt.request(context)
    expect(context.show.mock.calls[1][0]).toMatchObject({ buttons: ["取消", "退出应用"] })
    expect(context.minimize).not.toHaveBeenCalled()
  })

  it.each(["cancel", "destroy"])(
    "ignores late results after %s and suppresses duplicate dialogs",
    async (kind) => {
      const { prompt, context } = fixture()
      let finish!: (value: { response: number }) => void
      context.show.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const pending = prompt.request(context)
      await prompt.request(context)
      expect(context.show).toHaveBeenCalledTimes(1)
      if (kind === "cancel") prompt.cancel()
      else context.isAvailable.mockReturnValue(false)
      finish({ response: 1 })
      await pending
      expect(context.quit).not.toHaveBeenCalled()
      expect(prompt.isOpen).toBe(false)
    }
  )

  it("releases its lock after a native dialog error", async () => {
    const { prompt, context } = fixture()
    context.show.mockRejectedValueOnce(new Error("dialog failed"))
    await expect(prompt.request(context)).rejects.toThrow("dialog failed")
    await prompt.request(context)
    expect(context.show).toHaveBeenCalledTimes(2)
  })
})
