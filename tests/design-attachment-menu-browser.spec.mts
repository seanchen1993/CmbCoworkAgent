import assert from "node:assert/strict"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

interface UploadEvent {
  kind: string
  menuMounted: boolean
  userActivation: boolean
}

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: "tsx",
    contents: `
      import React, { useRef, useState } from "react";
      import { createRoot } from "react-dom/client";
      import { DesignAttachmentMenu } from "./src/renderer/src/components/design/DesignAttachmentMenu";

      window.uploadEvents = [];
      function Fixture() {
        const input = useRef(null);
        const [disabled, setDisabled] = useState(false);
        const [filename, setFilename] = useState("");
        const record = (kind) => window.uploadEvents.push({
          kind,
          menuMounted: Boolean(document.querySelector('[role="menu"]')),
          userActivation: navigator.userActivation.isActive
        });
        return <>
          <input ref={input} type="file" accept="image/*" hidden onChange={event => {
            setFilename(event.target.files?.[0]?.name || "");
            event.target.value = "";
          }} />
          <DesignAttachmentMenu attachmentLoading={false} importDisabled={disabled}
            showContextActions={true}
            onUploadFile={() => record("document")}
            onUploadScreenshot={() => { record("screenshot"); input.current.click(); }}
            onImportPrototypeZip={() => { record("zip"); document.getElementById("native-focus").focus(); }}
            onImportHtml={() => record("html")}
            onImportUrl={() => record("url")}
            onAttachCode={() => record("code")} />
          <input id="native-focus" aria-label="文件窗口焦点" />
          <button onClick={() => setDisabled(!disabled)}>切换禁用</button>
          <output>{filename}</output>
        </>;
      }
      createRoot(document.getElementById("root")).render(<Fixture />);
    `
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  alias: { "@": resolve("src/renderer/src") },
  define: { "process.env.NODE_ENV": '"test"' }
})
const server = createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript" : "text/html")
  response.end(
    request.url === "/app.js"
      ? bundle.outputFiles[0].contents
      : `
    <!doctype html><meta charset="utf-8">
    <style>
      @keyframes close-menu { from { opacity: 1 } to { opacity: 0 } }
      [role="menu"][data-state="closed"] { animation: close-menu 120ms; }
    </style>
    <div id="root"></div><script src="/app.js"></script>
  `
  )
})
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
  const trigger = page.getByRole("button", { name: "更多上传选项", exact: true })
  const menu = page.getByRole("menu")
  const events = (): Promise<UploadEvent[]> =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            uploadEvents: UploadEvent[]
          }
        ).uploadEvents
    )

  // Escape should restore keyboard focus without starting an upload.
  await trigger.click()
  await page.keyboard.press("Escape")
  await menu.waitFor({ state: "detached" })
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "更多上传选项"
  )
  assert.deepEqual(await events(), [])

  // Test the real hidden-input chooser, including cancel and selecting the same file again.
  for (const filename of [null, "screenshot.png", "screenshot.png"]) {
    await trigger.click()
    const choosing = page.waitForEvent("filechooser")
    await menu.getByRole("menuitem", { name: "上传截图", exact: true }).click()
    const chooser = await choosing
    assert.deepEqual(
      (await events()).at(-1),
      {
        kind: "screenshot",
        menuMounted: false,
        userActivation: true
      },
      "the menu must finish closing before opening the screenshot chooser"
    )
    await chooser.setFiles(
      filename
        ? {
            name: filename,
            mimeType: "image/png",
            buffer: Buffer.from("image fixture")
          }
        : []
    )
    if (filename)
      await page.waitForFunction(
        () => document.querySelector("output")?.textContent === "screenshot.png"
      )
    await menu.waitFor({ state: "detached" })
  }

  // Keyboard selection must open the ZIP picker after closing, without stealing its focus back.
  await trigger.focus()
  await page.keyboard.press("ArrowDown")
  await menu.waitFor()
  await page.waitForFunction(() => document.activeElement?.textContent?.includes("上传截图"))
  await page.keyboard.press("ArrowDown")
  await page.waitForFunction(() =>
    document.activeElement?.textContent?.includes("上传原型图压缩包")
  )
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => document.activeElement?.id === "native-focus")
  assert.equal((await events()).at(-1)?.kind, "zip")
  assert.equal((await events()).at(-1)?.menuMounted, false)
  await menu.waitFor({ state: "detached" })
  // Wait past the close animation and Radix's deferred autofocus cleanup.
  await page.waitForTimeout(200)
  assert.equal(
    await page.getByLabel("文件窗口焦点").evaluate((element) => element === document.activeElement),
    true
  )

  // Pointer selection and disabled items should keep the same semantics.
  await trigger.click()
  await menu.getByRole("menuitem", { name: "上传原型图压缩包", exact: true }).click()
  await menu.waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.id === "native-focus")
  assert.equal((await events()).filter((event) => event.kind === "zip").length, 2)
  assert.equal((await events()).at(-1)?.menuMounted, false)
  for (const [label, kind] of [
    ["上传 HTML 文件", "html"],
    ["通过内置浏览器打开", "url"]
  ]) {
    await trigger.click()
    await menu.getByRole("menuitem", { name: label, exact: true }).click()
    await menu.waitFor({ state: "detached" })
    await page.waitForFunction(
      (expected) =>
        (window as unknown as { uploadEvents: UploadEvent[] }).uploadEvents.at(-1)?.kind ===
        expected,
      kind
    )
    assert.equal((await events()).at(-1)?.menuMounted, false)
  }
  await page.getByRole("button", { name: "切换禁用", exact: true }).click()
  await trigger.click()
  assert.equal(
    await menu
      .getByRole("menuitem", { name: "上传原型图压缩包", exact: true })
      .getAttribute("aria-disabled"),
    "true"
  )
  await page.keyboard.press("Escape")
  assert.equal((await events()).filter((event) => event.kind === "zip").length, 2)
  assert.deepEqual(errors, [])
  console.log(
    "PASS attachment menu: screenshot selection/cancel/reselect, ZIP mouse/keyboard focus, Escape and disabled imports"
  )
} finally {
  await browser?.close()
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done()))
  )
}
