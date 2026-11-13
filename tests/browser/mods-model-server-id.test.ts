import { expect, it } from "vitest"
import { startModsModelServer } from "../support/mods-model-server"

it("keeps provider response identities separate when an upgrade fixture restarts its model", async () => {
  const seed = await startModsModelServer({ responseIdPrefix: "legacy-seed" })
  const upgraded = await startModsModelServer({ responseIdPrefix: "legacy-upgraded" })
  try {
    const complete = async (url: string) => {
      const response = await fetch(`${url}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "fixture" }] })
      })
      const first = (await response.text()).split("\n").find((line) => line.startsWith("data: {"))!
      return JSON.parse(first.slice(6)).id
    }
    expect(await complete(seed.url)).toBe("legacy-seed-1")
    expect(await complete(upgraded.url)).toBe("legacy-upgraded-1")
    expect(await complete(upgraded.url)).toBe("legacy-upgraded-2")
  } finally {
    await seed.close()
    await upgraded.close()
  }
})
