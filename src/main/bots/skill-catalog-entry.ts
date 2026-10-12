import { readBotSkillCatalog } from "./skill-catalog-reader"

process.once("disconnect", () => process.exit(1))
process.once("message", async (input: unknown) => {
  try {
    const result = await readBotSkillCatalog(input)
    process.send?.({ result }, () => process.exit(0))
  } catch {
    process.send?.({ error: "技能目录读取失败，请检查 CMBDevClaw 技能与插件设置" }, () =>
      process.exit(1)
    )
  }
})
