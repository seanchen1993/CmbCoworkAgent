/** Actual initial skill section and loopback HTTP; no organization API or parser replacement. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { join, resolve } from "node:path"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { build } from "esbuild"
import { chromium, type Browser, type Page } from "playwright"
import type { OrganizationSkillsBrowserState } from "./support/organization-skills-initial-load-fixture"

type Scenario =
  | "html"
  | "json-mime-html"
  | "redirect-html"
  | "broken-json"
  | "invalid-shape"
  | "invalid-item"
  | "missing"
interface RequestFact {
  scenario: string
  kind: string
  pathname: string
  status: number
}
interface CaseResult {
  scenario: Scenario
  checks: string[]
  requests: RequestFact[]
  fixture: OrganizationSkillsBrowserState
  pageErrors: string[]
  unexpectedNetwork: string[]
}

const scenarios: Scenario[] = [
  "html",
  "json-mime-html",
  "redirect-html",
  "broken-json",
  "invalid-shape",
  "invalid-item",
  "missing"
]
const initialDraft = "这是我尚未发送的聊天草稿"
const fixturePath = "tests/support/organization-skills-initial-load-fixture.tsx"
const htmlBody = "<!doctype html><html><body>PRIVATE_ORG_HTML_MARKER</body></html>"
const orgItem = {
  id: 701,
  slug: "organization-fixture-helper",
  name: "组织知识助手",
  description: "Only a local HTTP fixture, never installed or executed",
  icon: "",
  sourceOrigin: "ORG",
  sourceOriginName: "本地验收",
  manager: {
    name: "Fixture",
    userId: "fixture",
    ystId: "fixture",
    openId: "fixture",
    department: "Fixture"
  },
  belongsToSystems: [],
  labels: [{ labelId: "fixture", labelName: "验收" }],
  category: "SHARE",
  isDuplicated: false,
  versions: [
    {
      id: 702,
      skillId: 701,
      name: "V1.0.0",
      allowBrowserAccess: false,
      updatedAt: "2026-11-02T00:00:00Z"
    }
  ],
  createdAt: "2026-11-02T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
  isSubscribe: false,
  subscriptionCount: 0
}
const successPayload = {
  returnCode: "SUC0000",
  body: {
    total: 1,
    list: [orgItem],
    pageNum: 1,
    pageSize: 4,
    pages: 1,
    hasNextPage: false,
    hasPreviousPage: false
  }
}

function respondJson(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" })
  response.end(JSON.stringify(value))
}

async function waitForHeld(held: Map<string, ServerResponse>, scenario: string) {
  const deadline = Date.now() + 5000
  while (!held.has(scenario)) {
    assert(Date.now() < deadline, "The manual retry must reach the real local HTTP server")
    await new Promise((done) => setTimeout(done, 20))
  }
}

async function assertDraft(page: Page, selected: string[]) {
  const draft = await page.getByRole("textbox", { name: "聊天草稿", exact: true }).inputValue()
  assert.equal(draft, [initialDraft, ...selected.map((name) => `/skill ${name}`)].join("\n"))
}

async function main() {
  const root = resolve(".")
  const renderer = join(root, "src/renderer/src")
  const output = join(root, "output", `organization-skills-initial-load-${randomUUID()}`)
  mkdirSync(output, { recursive: true })
  const requests: RequestFact[] = []
  const held = new Map<string, ServerResponse>()
  const bundles = new Map<string, string>()
  const counts = new Map<string, number>()
  let css = ""
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid")
    const parts = url.pathname.split("/").filter(Boolean)
    const scenario = parts[1] ?? "unknown"
    if (parts[0] === "fixture") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/production.css"></head><body><div id="root"></div><script defer src="/bundle/${scenario}.js"></script></body></html>`
      )
    } else if (parts[0] === "bundle") {
      response.writeHead(200, { "content-type": "application/javascript" })
      response.end(bundles.get(scenario.replace(/\.js$/, "")))
    } else if (url.pathname === "/production.css") {
      response.writeHead(200, { "content-type": "text/css" })
      response.end(css)
    } else if (parts[0] === "market" && url.pathname.endsWith("/list/skill")) {
      requests.push({ scenario, kind: "market-list", pathname: url.pathname, status: 200 })
      respondJson(response, { type: "skill", items: [] })
    } else if (parts[0] === "org" && url.pathname.endsWith("/skill/page")) {
      const count = (counts.get(scenario) ?? 0) + 1
      counts.set(scenario, count)
      requests.push({
        scenario,
        kind: "org-page",
        pathname: url.pathname,
        status: scenario === "redirect-html" && count === 1 ? 302 : 200
      })
      if (count > 1) {
        held.set(scenario, response)
        return
      }
      if (scenario === "redirect-html") {
        response.writeHead(302, {
          location: `/login/${scenario}?fixture_nonce=DO_NOT_DISPLAY_URL_QUERY`
        })
        response.end()
      } else if (scenario === "broken-json") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end('{"returnCode":"SUC0000","body":')
      } else if (scenario === "invalid-shape") {
        respondJson(response, ["not-an-organization-envelope"])
      } else if (scenario === "invalid-item") {
        respondJson(response, {
          ...successPayload,
          body: { ...successPayload.body, list: [{ ...orgItem, name: { bad: true } }] }
        })
      } else {
        response.writeHead(200, {
          "content-type":
            scenario === "json-mime-html" ? "application/json" : "text/html; charset=utf-8"
        })
        response.end(htmlBody)
      }
    } else if (parts[0] === "login") {
      requests.push({ scenario, kind: "redirect-login-html", pathname: url.pathname, status: 200 })
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(htmlBody)
    } else if (url.pathname === "/favicon.ico") {
      response.writeHead(204)
      response.end()
    } else {
      requests.push({ scenario, kind: "unexpected", pathname: url.pathname, status: 404 })
      response.writeHead(404)
      response.end("Unexpected local fixture request")
    }
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const origin = `http://127.0.0.1:${address.port}`
  const results: CaseResult[] = []
  let activePage: Page | undefined
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({
      headless: true,
      ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
    })
    let sourceInputs: string[] = []
    for (const scenario of scenarios) {
      const bundle = await build({
        entryPoints: [join(root, fixturePath)],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        jsx: "automatic",
        alias: { "@": renderer },
        define: {
          "import.meta.env": JSON.stringify({
            DEV: false,
            VITE_API_BASE_URL: `${origin}/market/${scenario}`,
            VITE_OPEN_ASSISTANT_HUB_GATEWAY_URL:
              scenario === "missing" ? "" : `${origin}/org/${scenario}`
          })
        },
        metafile: true,
        logLevel: "error"
      })
      bundles.set(scenario, bundle.outputFiles[0].text)
      writeFileSync(join(output, `${scenario}.js`), bundle.outputFiles[0].text)
      sourceInputs = Object.keys(bundle.metafile.inputs).filter(
        (name) => name.startsWith("src/") || name === fixturePath
      )
    }
    const cssPath = join(renderer, "index.css")
    const compiler = await compile(readFileSync(cssPath, "utf8"), {
      base: renderer,
      from: cssPath,
      onDependency: () => undefined
    })
    const candidates = new Scanner({}).scanFiles(
      sourceInputs.map((name) => ({
        content: readFileSync(join(root, name), "utf8"),
        extension: name.endsWith(".tsx") ? "tsx" : "ts"
      }))
    )
    css = compiler.build(candidates)
    writeFileSync(join(output, "production.css"), css)
    for (const scenario of scenarios) {
      const pageErrors: string[] = []
      const unexpectedNetwork: string[] = []
      const checks: string[] = []
      const context = await browser.newContext({ viewport: { width: 1100, height: 850 } })
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url())
        if (url.origin === origin) return route.continue()
        unexpectedNetwork.push(`${url.protocol}//${url.host}${url.pathname}`)
        return route.abort("blockedbyclient")
      })
      const page = await context.newPage()
      activePage = page
      page.setDefaultTimeout(10_000)
      page.on("pageerror", (error) => pageErrors.push(error.message))
      const responses: Array<{ pathname: string; status: number; redirectedFrom: string | null }> =
        []
      page.on("response", (response) => {
        const redirectedFrom = response.request().redirectedFrom()?.url()
        responses.push({
          pathname: new URL(response.url()).pathname,
          status: response.status(),
          redirectedFrom: redirectedFrom ? new URL(redirectedFrom).pathname : null
        })
      })
      await page.goto(`${origin}/fixture/${scenario}`)
      const status = page.getByRole("status", { name: "组织技能加载状态", exact: true })
      await status.waitFor()
      const common = page.getByText("通用场景", { exact: true })
      await common.waitFor()
      const statusText = await status.innerText()
      assert(
        statusText.includes(scenario === "missing" ? "组织技能服务未配置" : "组织技能暂时无法加载")
      )
      assert(statusText.includes("可继续聊天和使用本地技能"))
      assert(
        !/Unexpected token|doctype|PRIVATE_ORG_HTML_MARKER|DO_NOT_DISPLAY_URL_QUERY|not-an-organization-envelope|SUC0000|<html/i.test(
          await page.locator("body").innerText()
        )
      )
      const statusBox = await status.boundingBox(),
        commonBox = await common.boundingBox()
      assert(
        statusBox && commonBox && statusBox.y < commonBox.y,
        "The actual organization failure status must remain above 通用场景"
      )
      await assertDraft(page, [])
      await page.getByRole("button", { name: "创建新技能包", exact: true }).click()
      await assertDraft(page, ["skill-creator"])
      checks.push(
        "initial organization failure is safe Chinese text above the usable local common skills"
      )
      await page.screenshot({ path: join(output, `${scenario}-initial.png`), fullPage: true })
      if (scenario === "missing") {
        assert.equal(await status.getByRole("button").count(), 0)
        assert.equal(counts.get(scenario) ?? 0, 0)
        const state = await page.evaluate(() => window.organizationSkillsFixture)
        assert.equal(state.identityReads, 0)
        await page.getByRole("button", { name: "定时任务管理", exact: true }).click()
        await assertDraft(page, ["skill-creator", "scheduler-assistant"])
        checks.push(
          "missing gateway makes no organization request or identity read, while local skills remain usable"
        )
      } else {
        assert.equal(counts.get(scenario), 1)
        if (scenario === "redirect-html") {
          assert(
            responses.some(
              (row) =>
                row.pathname === `/login/${scenario}` &&
                row.status === 200 &&
                row.redirectedFrom === `/org/${scenario}/gw/mgr/open-api/skill/page`
            ),
            "The browser must follow a real HTTP 302 to the local HTML login page"
          )
        }
        await status.getByRole("button", { name: "重试", exact: true }).click()
        await waitForHeld(held, scenario)
        const pendingRetry = status.getByRole("button", { name: "正在重试…", exact: true })
        await pendingRetry.waitFor()
        assert.equal(await pendingRetry.isDisabled(), true)
        assert.equal(counts.get(scenario), 2)
        await page.getByRole("button", { name: "隐藏技能推荐", exact: true }).click()
        await page.getByRole("button", { name: "显示技能推荐", exact: true }).click()
        await page.getByRole("button", { name: "定时任务管理", exact: true }).click()
        await assertDraft(page, ["skill-creator", "scheduler-assistant"])
        assert.equal(
          counts.get(scenario),
          2,
          "Remount must share the pending retry without another request"
        )
        checks.push(
          "one manual retry is disabled while pending; remount shares it and local skill selection preserves the draft"
        )
        respondJson(held.get(scenario)!, successPayload)
        held.delete(scenario)
        await page.getByRole("button", { name: "组织知识助手", exact: true }).waitFor()
        assert.equal(await status.count(), 0)
        await assertDraft(page, ["skill-creator", "scheduler-assistant"])
        await page.getByRole("button", { name: "隐藏技能推荐", exact: true }).click()
        await page.getByRole("button", { name: "显示技能推荐", exact: true }).click()
        await page.getByRole("button", { name: "组织知识助手", exact: true }).waitFor()
        assert.equal(
          counts.get(scenario),
          2,
          "Successful response must retain the original cache on remount"
        )
        checks.push(
          "retry recovers the actual organization list and successful cache survives remount"
        )
        await page.screenshot({ path: join(output, `${scenario}-recovered.png`), fullPage: true })
      }
      const fixture = await page.evaluate(() => window.organizationSkillsFixture)
      assert.deepEqual(fixture.selectedSkills, ["skill-creator", "scheduler-assistant"])
      assert.deepEqual(fixture.navigation, [])
      assert.deepEqual(fixture.forbiddenCalls, [])
      assert.equal(fixture.sends, 0)
      assert.deepEqual(pageErrors, [])
      assert.deepEqual(unexpectedNetwork, [])
      const caseRequests = requests.filter((row) => row.scenario === scenario)
      assert(
        caseRequests.some((row) => row.kind === "market-list"),
        "Ordinary market API uses the real local server"
      )
      assert(!caseRequests.some((row) => row.kind === "unexpected"))
      results.push({
        scenario,
        checks,
        requests: caseRequests,
        fixture,
        pageErrors,
        unexpectedNetwork
      })
      await context.close()
      activePage = undefined
      console.log(`PASS organization initial load: ${scenario}`)
    }
    assert.equal(held.size, 0)
    const sources = Object.fromEntries(
      sourceInputs.map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(join(root, name)))
          .digest("hex")
      ])
    )
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          scope:
            "Actual SkillsByCategorySection + unmodified organization/market API + local HTTP; fixture IPC and draft; no full Electron, real SSO or model claim",
          origin,
          sources,
          results
        },
        null,
        2
      ) + "\n"
    )
    console.log(`PASS organization initial-load browser regression: ${output}`)
  } catch (error) {
    if (activePage && !activePage.isClosed())
      await activePage
        .screenshot({ path: join(output, "failure.png"), fullPage: true })
        .catch(() => undefined)
    writeFileSync(
      join(output, "failure.json"),
      JSON.stringify(
        {
          passed: false,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          results,
          requests
        },
        null,
        2
      ) + "\n"
    )
    throw error
  } finally {
    for (const response of held.values()) response.destroy()
    held.clear()
    try {
      await browser?.close()
    } finally {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    }
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
