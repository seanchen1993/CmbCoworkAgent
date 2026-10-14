import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/mods-link-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } })
  const errors: string[] = []
  const checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(
      page,
      `
      import {Element} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionPanes.tsx"))};
      const opened=[];window.electron={...window.electron,openExternal:async href=>{opened.push(href)}};
      function Fixture(){
        const [href,setHref]=useState(""),[count,setCount]=useState(0);
        window.linkFixture={setHref,opened};
        const link={type:"Link",props:{href,label:"Read guide"},children:[]};
        const button={type:"Button",props:{key:"sibling",label:"Sibling:"+count},press:{plugin:"links",handle:1}};
        return <main><p>Sibling text remains</p><Element node={link} busy={false} act={async()=>{}}/>
          <Element node={button} busy={false} act={async()=>setCount(count+1)}/></main>;
      }
      host.render(<Fixture/>);
    `,
      [browserWorkerPlugin()]
    )
    for (const href of [
      "",
      "javascript:alert(1)",
      "file:///C:/private",
      "mailto:test@example.com",
      "http://example.com/",
      "https://example.com/a b",
      "https://user@example.com/",
      "https:/example.com",
      "https:///example.com",
      "https:////example.com",
      "http:localhost",
      "https://example.com\\path",
      null,
      { inert: true }
    ]) {
      await page.evaluate((href) => window.linkFixture.setHref(href), href)
      await page.getByText("Read guide", { exact: true }).click()
      assert.equal(await page.getByRole("link").count(), 0)
      assert.equal(await page.locator("a[href]").count(), 0)
      assert.equal(
        await page.getByText("Read guide", { exact: true }).getAttribute("tabindex"),
        null
      )
      assert.equal(await page.evaluate(() => window.linkFixture.opened.length), 0)
    }
    checks.push(
      "fourteen unsupported/raw addresses draw unfocusable plain text and never open externally"
    )
    await page.getByRole("button", { name: "Sibling:0", exact: true }).click()
    await page.getByRole("button", { name: "Sibling:1", exact: true }).waitFor()
    checks.push("sibling text and actual control remain usable")
    for (const href of [
      "https://example.com",
      "https://example.com/guide",
      "http://localhost:8000/view"
    ]) {
      await page.evaluate((href) => window.linkFixture.setHref(href), href)
      const link = page.getByRole("link", { name: "Read guide", exact: true })
      await link.waitFor()
      assert.equal(await link.getAttribute("href"), href)
      await link.click()
      assert.equal(await page.evaluate(() => window.linkFixture.opened.at(-1)), href)
    }
    assert.equal(await page.evaluate(() => window.linkFixture.opened.length), 3)
    checks.push("safe HTTPS and localhost spelling reach the original mocked bridge once per click")
    await page.evaluate(() => window.linkFixture.setHref("javascript:alert(1)"))
    await page.getByRole("link").waitFor({ state: "detached" })
    await page.screenshot({ path: resolve(output, "plain-link-siblings.png") })
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          checks,
          errors,
          scope:
            "Actual React/browser rendering; external opening bridge is mocked, not an OS launch"
        },
        null,
        2
      )
    )
    for (const check of checks) console.log("PASS " + check)
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
