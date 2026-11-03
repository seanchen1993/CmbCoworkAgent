/** Production Mod element renderer; controlled action callbacks, no guest business execution. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const renderer = resolve("src/renderer/src")
  const output = resolve("output/mods-ui-layout-browser")
  mkdirSync(output, { recursive: true })
  const css = await compile(readFileSync(resolve(renderer, "index.css"), "utf8"), {
    base: renderer,
    onDependency: () => undefined
  })
  const candidates = new Scanner({}).scanFiles(
    ["components/chat/FunctionPanes.tsx", "components/ui/button.tsx"].map((file) => ({
      content: readFileSync(resolve(renderer, file), "utf8"),
      extension: "tsx"
    }))
  )
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(
      page,
      `
      import {Element} from ${JSON.stringify(resolve(renderer, "components/chat/FunctionPanes.tsx"))};
      import {validateFunctionTree} from ${JSON.stringify(resolve("src/shared/mods/v2/ui.ts"))};
      const longText="可读的完整内容".repeat(80);
      const tree={type:'Box',props:{flexDirection:'column',width:'100%',minWidth:0,gap:'lg',rowGap:'sm',padding:'md',backgroundColor:'black',overflow:'hidden'},children:[
        {type:'Text',props:{size:'heading',weight:'medium',color:'white'},children:['插件界面示例']},
        {type:'Box',props:{width:'100%',minWidth:0,flexWrap:'nowrap',columnGap:'sm',alignItems:'center'},children:[
          {type:'Box',props:{flexGrow:1,flexShrink:1,minWidth:0},children:[{type:'Text',props:{wrap:'truncate',size:'footnote',color:'white',mono:true,tabular:true},children:[longText]}]},
          {type:'Button',props:{key:'refresh',label:'刷新内容'},press:{plugin:'layout',handle:1}}
        ]}
      ]};
      validateFunctionTree(tree);
      window.layoutFixture={actions:[],shellClicks:0,longText};
      host.render(<main style={{padding:8,maxWidth:700}}>
        <button onClick={()=>window.layoutFixture.shellClicks++}>宿主关闭</button>
        {['pane','page','sidebar','toolbar'].map(place=><section key={place} data-placement={place} style={{width:'100%',marginTop:12}}>
          <Element node={tree} busy={false} act={async(node,kind)=>{window.layoutFixture.actions.push({place,kind,key:node.props.key})}}/>
        </section>)}
      </main>);
    `,
      [browserWorkerPlugin()]
    )
    await page.addStyleTag({ content: css.build(candidates) })
    for (const width of [1100, 360]) {
      await page.setViewportSize({ width, height: 800 })
      for (const place of ["pane", "page", "sidebar", "toolbar"]) {
        const section = page.locator(`[data-placement="${place}"]`)
        const refresh = section.getByRole("button", { name: "刷新内容", exact: true })
        await refresh.click()
        const measured = await section.evaluate((element) => {
          const title = Array.from(element.querySelectorAll("span")).find(
            (node) => node.textContent === "插件界面示例"
          )!
          const long = Array.from(element.querySelectorAll("span")).find((node) =>
            node.textContent?.startsWith("可读的完整内容")
          )!
          const style = getComputedStyle(title)
          return {
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            color: style.color,
            background: getComputedStyle(element.firstElementChild!).backgroundColor,
            padding: getComputedStyle(element.firstElementChild!).padding,
            rowGap: getComputedStyle(element.firstElementChild!).rowGap,
            columnGap: getComputedStyle(element.firstElementChild!).columnGap,
            fullLength: long.textContent?.length,
            clipped: getComputedStyle(long).textOverflow,
            scrollWidth: document.documentElement.scrollWidth,
            windowWidth: innerWidth
          }
        })
        assert.equal(measured.fontSize, "16px")
        assert.equal(measured.fontWeight, "500")
        assert.equal(measured.color, "rgb(255, 255, 255)")
        assert.equal(measured.background, "rgb(0, 0, 0)")
        assert.equal(measured.padding, "8px", "Absent side overrides must not erase padding")
        assert.equal(measured.rowGap, "4px", "Explicit row spacing overrides the shorthand")
        assert.equal(measured.columnGap, "12px", "Absent column override must preserve gap")
        assert.equal(measured.fullLength, "可读的完整内容".repeat(80).length)
        assert.equal(measured.clipped, "ellipsis")
        assert(measured.scrollWidth <= measured.windowWidth, "layout must fit a narrow host")
      }
      await page.getByRole("button", { name: "宿主关闭", exact: true }).click()
      await page.screenshot({ path: resolve(output, `layout-${width}.png`), fullPage: true })
    }
    assert.equal(await page.evaluate("window.layoutFixture.actions.length"), 8)
    assert.equal(await page.evaluate("window.layoutFixture.shellClicks"), 2)
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          scope:
            "Actual shared desktop element renderer in pane/page/sidebar/toolbar sized containers; controlled callbacks",
          widths: [1100, 360],
          errors
        },
        null,
        2
      )
    )
    console.log(
      "PASS bounded Mod layout, typography, named spacing, ANSI backgrounds, narrow controls and host shell"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
