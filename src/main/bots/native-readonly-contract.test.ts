import { expect, it } from "vitest"
import { botShellReadOnly, type BotExecutionConfig } from "./shell-contract"

it.each(["win32", "linux", "darwin"] as const)(
  "keeps explicit Host role restrictions on %s across every configured Windows mode",
  (platform) => {
    for (const windowsSandbox of ["none", "unelevated", "readonly", "elevated"] as const) {
      const execution: BotExecutionConfig = {
        windowsSandbox,
        resourceDirectory: "/fixed/resources"
      }
      expect(botShellReadOnly({ execution, readOnly: true }, platform)).toBe(true)
      for (const readOnly of [undefined, false])
        expect(botShellReadOnly({ execution, readOnly }, platform)).toBe(
          platform === "win32" && windowsSandbox === "readonly"
        )
    }
  }
)

it("keeps a Windows readonly preference authoritative when an older caller sends false or omits the role field", () => {
  const execution: BotExecutionConfig = {
    windowsSandbox: "readonly",
    resourceDirectory: "/fixed/resources"
  }
  expect(botShellReadOnly({ execution }, "win32")).toBe(true)
  expect(botShellReadOnly({ execution, readOnly: false }, "win32")).toBe(true)
})
