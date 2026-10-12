import { expect, it } from "vitest"
import { botSecretProtectionDescription } from "./bot-secrets"

it("describes the actual credential provider and does not present memory storage as persistent", () => {
  expect(botSecretProtectionDescription({ persistent: false, items: [] })).toContain(
    "重启后需要重新添加"
  )
  expect(
    botSecretProtectionDescription({ persistent: true, protection: "windows-dpapi", items: [] })
  ).toContain("Windows")
  const mac = botSecretProtectionDescription({
    persistent: true,
    protection: "macos-keychain",
    items: []
  })
  expect(mac).toContain("macOS 钥匙串")
  expect(mac).not.toContain("Windows")
  expect(botSecretProtectionDescription({ persistent: true, items: [] })).toContain("服务端配置")
})
