import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { expect, it } from "vitest"

it("opens a created project without forcing step selection and keeps editing optional", async () => {
  const bundle = await build({
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"test"' },
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
        import React,{useState}from'react';import{createRoot}from'react-dom/client';
        import{CreatedPluginProjectActions}from'./src/renderer/src/components/harness-board/CreatedPluginProjectActions';
        const calls=[];window.calls=calls;
        function Fixture(){const[busy,setBusy]=useState(false);window.setBusy=setBusy;
          return <CreatedPluginProjectActions name="生成的项目插件" busy={busy} error={null}
            onOpenProject={()=>calls.push('open-project')}
            onCustomizeSteps={()=>calls.push('customize-steps')}
            onDismiss={()=>calls.push('dismiss')}/>}
        createRoot(document.getElementById('root')).render(<Fixture/>);
      `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const region = page.getByRole("region", { name: "新项目已创建", exact: true })
    await region.getByRole("button", { name: "打开项目", exact: true }).click()
    expect(await page.evaluate("window.calls")).toEqual(["open-project"])
    expect(await page.getByRole("dialog").count()).toBe(0)
    await region.getByRole("button", { name: "调整步骤（可选）", exact: true }).click()
    expect(await page.evaluate("window.calls")).toEqual(["open-project", "customize-steps"])
    await page.evaluate("window.setBusy(true)")
    await expect
      .poll(() => region.getByRole("button", { name: "打开项目", exact: true }).isDisabled())
      .toBe(true)
    expect(
      await region.getByRole("button", { name: "调整步骤（可选）", exact: true }).isDisabled()
    ).toBe(true)
    expect(await region.getByRole("button", { name: "关闭", exact: true }).isDisabled()).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
  }
}, 60000)
