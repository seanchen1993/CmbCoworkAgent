import { expect, it } from "vitest"
import { createWindowsNativeSetupService } from "./windows-native-setup-service"
import { prepareWindowsNativeCi } from "../../../tests/prepare-bot-windows-native.mjs"

// These exercise the actual current non-Windows process. They do not mock a
// Windows kernel, administrator token, native capability or closure receipt.
const service = () => {
  let calls = 0
  const unreachable = () => {
    calls++
    throw new Error("No filesystem/native port allowed")
  }
  return {
    value: createWindowsNativeSetupService({
      directory: async () => unreachable(),
      configuration: unreachable,
      helperEntry: "/must-not-be-opened/helper.js"
    }),
    calls: () => calls
  }
}
it.skipIf(process.platform === "win32")(
  "actual non-Windows status does not read a Host or native package",
  async () => {
    const f = service()
    expect(await f.value.getStatus()).toMatchObject({ state: "unavailable" })
    expect(f.calls()).toBe(0)
  }
)
it.skipIf(process.platform === "win32")(
  "actual non-Windows setup returns a definitive unavailable outcome without provisioning",
  async () => {
    const f = service(),
      nonce = "cc6b2b76-6a0a-4434-8b4e-14c4e019c418"
    expect(await f.value.initialize({ nonce, scope: "a".repeat(64) })).toMatchObject({
      nonce,
      success: false,
      definitive: true,
      status: { state: "unavailable" }
    })
    expect(f.calls()).toBe(0)
  }
)
it("strict setup input cannot select the process-owned helper or native directory", async () => {
  const f = service()
  expect(() =>
    f.value.initialize({
      nonce: "cc6b2b76-6a0a-4434-8b4e-14c4e019c418",
      scope: "a".repeat(64),
      helperEntry: "/chosen",
      verified: true
    })
  ).toThrow()
  expect(f.calls()).toBe(0)
})
it.skipIf(process.platform === "win32")(
  "CI preparation on the actual Mac/Linux process fails before any administrator action",
  async () => {
    await expect(
      prepareWindowsNativeCi({ GITHUB_ACTIONS: "true", RUNNER_OS: "Windows" })
    ).rejects.toThrow("real Windows")
  }
)
