import { readBotHarnessCatalog } from "./harness-catalog-reader"
process.once("disconnect", () => process.exit(1))
process.once("message", async (input: { sources: unknown; binding: unknown }) => {
  try {
    const result = await readBotHarnessCatalog(input)
    process.send?.({ result }, () => process.exit(0))
  } catch {
    process.send?.({ error: "项目上下文读取失败，请检查项目、插件和本机配置" }, () =>
      process.exit(1)
    )
  }
})
