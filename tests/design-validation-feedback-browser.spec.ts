import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { chromium } from "playwright"
import {
  materializeTweaks,
  tweakSourceDiagnostics,
  tweakSourceIssues
} from "../src/shared/design-tweaks"
import { designGenerationBrowserProbe } from "../src/main/services/design/generation-browser-probe"
import { runBoundedDesignValidation } from "../src/main/services/design/browser-validation-runner"
import {
  injectDesignBrowserValidationProbe,
  formatDesignBrowserValidation,
  parseDesignBrowserRuntimeIssue,
  type DesignBrowserValidationIssue
} from "../src/main/services/design/browser-validation-feedback"

const root = await mkdtemp(join(tmpdir(), "design-validation-feedback-"))
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
  headless: true
})
try {
  const page = await browser.newPage()
  const html = `<!doctype html><html><head><style>
:root{--accent-b:#b45309}
.action{background:#b45309}
</style></head><body><button class="action" onclick="this.textContent='已撤销'">撤销</button>
<script type="application/design-tweaks+json">{"defaults":{"accent":"#b45309"},"schema":{"accent":{"type":"color","label":"强调色"}},"bindings":{"accent":[{"type":"css-var","name":"--accent-b"}]}}</script>
</body></html>`
  const source = join(root, "source.html"),
    repair = join(root, "repair.html"),
    checked = join(root, "checked.html")
  await writeFile(source, html)
  await writeFile(checked, materializeTweaks(html))
  await page.goto(pathToFileURL(checked).href)
  const failures = await page.evaluate(() =>
    (window as unknown as { __designValidateTweaks(): string[] }).__designValidateTweaks()
  )
  assert.deepEqual(failures, ["accent 未引用 CSS 变量 --accent-b"])
  const report = formatDesignBrowserValidation(
    { ok: false, issues: failures.map((message) => ({ type: "structure", message })) },
    { html, filePath: source }
  )
  assert.ok(report.includes(".action{background:#b45309}"))
  assert.ok(report.includes("var(--accent-b)"))

  // The host seeds a complete draft; one local edit fixes it without regenerating the page.
  await writeFile(repair, html)
  await writeFile(
    repair,
    (await readFile(repair, "utf8")).replace(
      ".action{background:#b45309}",
      ".action{background:var(--accent-b)}"
    )
  )
  assert.equal(await readFile(source, "utf8"), html)
  await writeFile(checked, materializeTweaks(await readFile(repair, "utf8")))
  await page.reload()
  assert.deepEqual(
    await page.evaluate(() =>
      (window as unknown as { __designValidateTweaks(): string[] }).__designValidateTweaks()
    ),
    []
  )
  await page.getByRole("button", { name: "撤销", exact: true }).click()
  assert.equal(await page.getByRole("button").textContent(), "已撤销")

  // Business JS reads the CSS setting correctly, but does not implement a live
  // visual binding. Remove only its unsupported Tweaks entry, keeping behavior.
  const businessConfig = {
    defaults: { accent: "#b45309", maxQuick: 10 },
    schema: { accent: { type: "color" }, maxQuick: { type: "number", min: 1, max: 12 } },
    bindings: {
      accent: [{ type: "css-var", name: "--accent" }],
      maxQuick: [{ type: "css-var", name: "--max-quick" }]
    }
  }
  const businessPage = (config: unknown) =>
    `<!doctype html><html><head><style>:root{--max-quick:10}.action{background:var(--accent)}</style></head><body><button class="action">快捷问题</button><script type="application/design-tweaks+json">${JSON.stringify(config)}</script><script>window.quickCount=Number(getComputedStyle(document.documentElement).getPropertyValue('--max-quick'));</script></body></html>`
  const businessHtml = businessPage(businessConfig)
  await writeFile(checked, materializeTweaks(businessHtml))
  await page.reload()
  assert.equal(
    await page.evaluate(() => (window as unknown as { quickCount: number }).quickCount),
    10
  )
  const businessFailures = await page.evaluate(() =>
    (window as unknown as { __designValidateTweaks(): string[] }).__designValidateTweaks()
  )
  assert.deepEqual(businessFailures, ["maxQuick 未引用 CSS 变量 --max-quick"])
  const businessReport = formatDesignBrowserValidation(
    { ok: false, issues: businessFailures.map((message) => ({ type: "structure", message })) },
    { html: businessHtml, filePath: source, repairTargetPath: repair }
  )
  assert.ok(businessReport.includes("getPropertyValue('--max-quick')"))
  assert.ok(businessReport.includes("defaults、schema、bindings 三处同时移除"))
  const withoutBusiness = (values: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(values).filter(([key]) => key !== "maxQuick"))
  const businessFixed = businessPage({
    defaults: withoutBusiness(businessConfig.defaults),
    schema: withoutBusiness(businessConfig.schema),
    bindings: withoutBusiness(businessConfig.bindings)
  })
  assert.deepEqual(tweakSourceIssues(businessFixed), [])
  await writeFile(checked, materializeTweaks(businessFixed))
  await page.reload()
  assert.deepEqual(
    await page.evaluate(() =>
      (window as unknown as { __designValidateTweaks(): string[] }).__designValidateTweaks()
    ),
    []
  )
  assert.equal(
    await page.evaluate(() => (window as unknown as { quickCount: number }).quickCount),
    10
  )

  // A real popup target survives repeated opening and live text updates.
  const popupConfig = {
    defaults: { failText: "系统繁忙" },
    schema: { failText: { type: "text", maxLength: 50 } },
    bindings: { failText: [{ type: "text", selector: "#leaf-fail-text" }] }
  }
  const popupHtml = `<!doctype html><html><body><button onclick="document.getElementById('modal-body').hidden=false">显示失败</button><div id="modal-body" hidden><span id="leaf-fail-text">系统繁忙</span></div><script type="application/design-tweaks+json">${JSON.stringify(popupConfig)}</script></body></html>`
  const invalidPopup = popupHtml.replace('"type":"text","maxLength":50', '"type":"integer"')
  const popupDiagnostics = tweakSourceDiagnostics(invalidPopup)
  assert.ok(popupDiagnostics.some((issue) => issue.fieldPath === 'schema["failText"].type'))
  await writeFile(checked, materializeTweaks(popupHtml))
  await page.reload()
  assert.deepEqual(
    await page.evaluate(() =>
      (window as unknown as { __designValidateTweaks(): string[] }).__designValidateTweaks()
    ),
    []
  )
  await page.getByRole("button", { name: "显示失败" }).click()
  await page.evaluate(() =>
    (
      window as unknown as { __designApplyTweaks(values: Record<string, string>): void }
    ).__designApplyTweaks({ failText: "稍后重试" })
  )
  await page.getByRole("button", { name: "显示失败" }).click()
  assert.equal(await page.locator("#leaf-fail-text").textContent(), "稍后重试")
  assert.equal(await page.locator("#leaf-fail-text").isVisible(), true)

  const issues: DesignBrowserValidationIssue[] = []
  page.on("console", (message) => {
    const issue = parseDesignBrowserRuntimeIssue(message.text())
    if (issue) issues.push(issue)
  })
  const broken =
    "<!doctype html><html><head></head><body>\n<script>missingHandler();</script>\n</body></html>"
  const validationHtml = injectDesignBrowserValidationProbe(broken)
  await writeFile(checked, validationHtml)
  await page.reload()
  assert.ok(issues.some((issue) => issue.message.includes("missingHandler")))
  const runtimeReport = formatDesignBrowserValidation(
    { ok: false, issues },
    { html: broken, filePath: source, validationHtml, validationPath: checked }
  )
  assert.ok(runtimeReport.includes(`原始源码定位：${source}:2`))
  assert.ok(runtimeReport.includes("missingHandler();"))

  const numericConfig = {
    defaults: { radius: 10, pad: 12, ratio: 1.5, opacity: 0.8, zero: 0 },
    schema: Object.fromEntries(
      ["radius", "pad", "ratio", "opacity", "zero"].map((key) => [
        key,
        { type: "number", label: key }
      ])
    ),
    bindings: Object.fromEntries(
      ["radius", "pad", "ratio", "opacity", "zero"].map((key) => [
        key,
        [{ type: "css-var", name: `--${key}` }]
      ])
    )
  }
  const numericHtml = `<!doctype html><html><head><style>.lengths{border-radius:var(--radius);padding:calc(var(--pad) + 4px);line-height:var(--ratio);opacity:var(--opacity);gap:var(--zero)}</style></head><body><div class="lengths">数值样式</div><script type="application/design-tweaks+json">${JSON.stringify(numericConfig)}</script></body></html>`
  await writeFile(checked, materializeTweaks(numericHtml))
  await page.reload()
  const numericIssues = await page.evaluate(designGenerationBrowserProbe)
  assert.ok(numericIssues.some((issue) => issue.message.includes("--radius")))
  assert.ok(numericIssues.some((issue) => issue.message.includes("--pad")))
  assert.ok(!numericIssues.some((issue) => /--ratio|--opacity|--zero/.test(issue.message)))
  const fixedNumeric = numericHtml
    .replace('"name":"--radius"', '"name":"--radius","unit":"px"')
    .replace('"name":"--pad"', '"name":"--pad","unit":"px"')
  await writeFile(checked, materializeTweaks(fixedNumeric))
  await page.reload()
  assert.deepEqual(await page.evaluate(designGenerationBrowserProbe), [])
  assert.equal(
    await page.locator(".lengths").evaluate((element) => getComputedStyle(element).padding),
    "16px"
  )

  const brokenRole = `<!doctype html><html><head></head><body><b id="role-label">主管</b><div role="tablist"><button role="tab" aria-selected="true">主管</button><button id="teller" role="tab" aria-selected="false" onclick="document.getElementById('role-label').textContent='柜员'">柜员</button></div><script>document.getElementById('role-label').remove();</script></body></html>`
  await writeFile(checked, injectDesignBrowserValidationProbe(brokenRole))
  await page.reload()
  const interactionIssues = await page.evaluate(designGenerationBrowserProbe)
  assert.ok(
    interactionIssues.some(
      (issue) =>
        issue.type === "interaction" &&
        issue.selector === "#teller" &&
        issue.message.includes("null")
    )
  )

  const healthyTabs = `<!doctype html><html><body><script>window.clicks=0;window.submits=0;</script>${Array.from({ length: 5 }, (_, i) => `<div role="tablist"><button role="tab" aria-selected="true">当前</button><button role="tab" aria-selected="false" onclick="window.clicks++;this.setAttribute('aria-selected','true')">切换 ${i}</button></div>`).join("")}<form onsubmit="event.preventDefault();window.submits++"><button role="tab" aria-selected="false" type="submit">提交</button></form></body></html>`
  await writeFile(checked, healthyTabs)
  await page.reload()
  assert.deepEqual(await page.evaluate(designGenerationBrowserProbe), [])
  assert.equal(await page.evaluate(() => (window as unknown as { clicks: number }).clicks), 3)
  assert.equal(await page.evaluate(() => (window as unknown as { submits: number }).submits), 0)

  const stalled = await browser.newPage()
  let closed = false
  const timedOut = await runBoundedDesignValidation({
    load: async () => {
      await stalled.goto("about:blank")
    },
    inspect: () => stalled.evaluate(() => new Promise<void>(() => undefined)),
    close: () => {
      closed = true
      void stalled.close().catch(() => undefined)
    },
    issues: [],
    signal: new AbortController().signal,
    timeoutMs: 100
  })
  assert.ok(closed)
  assert.ok(timedOut.issues.some((issue) => issue.type === "timeout"))
  await stalled.close()
  console.log(
    "✓ Real Chrome: precise feedback, local repair, numeric CSS, bounded interactions and stalled-probe cleanup"
  )
} finally {
  await browser.close()
  await rm(root, { recursive: true, force: true })
}
