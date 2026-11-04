/** Real sidebar portal, panel routing and resize hook; heavy resource bodies are inert probes. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 850 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await mount(
      page,
      `
      import {ClawSidebarShell} from ${JSON.stringify(resolve("src/renderer/src/components/panels/ClawSidebarHost.tsx"))};
      import {RightPanelDock} from ${JSON.stringify(resolve("src/renderer/src/components/panels/RightPanelDock.tsx"))};
      import {ResourcePanelOverlay} from ${JSON.stringify(resolve("src/renderer/src/components/panels/ResourcePanelOverlay.tsx"))};
      import {useRightPanelLayout} from ${JSON.stringify(resolve("src/renderer/src/components/panels/useRightPanelLayout.ts"))};
      import {openResourcePanelOverlay} from ${JSON.stringify(resolve("src/renderer/src/lib/resource-panel-overlay-events.ts"))};
      let fixtureMounts=0,fixtureUnmounts=0,fixtureRenders=0;
      function PersistentDrawing(){useEffect(()=>{fixtureMounts++;return()=>fixtureUnmounts++},[]);return <input aria-label='Plugin draft' defaultValue='Retain me'/>}
      function PanelFixture(){
        fixtureRenders++;
        const module=useAppStore(s=>s.rightModule),collapsed=useAppStore(s=>s.rightPanelCollapsed);
        const [focused,setFocused]=useState(false);
        const layout=useRightPanelLayout({rightModule:module});
        const flow=useChatFlow('a','a',false);
        window.shellFixture={counts:()=>[fixtureMounts,fixtureUnmounts],focus:setFocused,
          fullscreen:()=>[layout.previewFullscreen,layout.browserFullscreen],
          browserFullscreen:layout.setBrowserFullscreen,previewFullscreen:layout.setPreviewFullscreen,
          renders:()=>fixtureRenders};
        return <><nav aria-label='Panel modules'>
          <button aria-pressed={module==='claw'} onClick={()=>openClawSidebar('run')}>Task</button>
          {['preview','git','browser'].map(mode=><button key={mode} aria-pressed={module===mode} onClick={()=>openResourcePanelOverlay(mode)}>{mode}</button>)}
          <button aria-pressed={module==='work'} onClick={()=>useAppStore.getState().setRightModule('work')}>work</button>
          <button onClick={()=>useAppStore.getState().setRightPanelCollapsed(!collapsed)}>{collapsed?'Expand':'Collapse'}</button>
        </nav><main style={{height:650,display:'flex'}} ref={layout.rightPanelSplitRef}>
          <section data-chat-column style={{flex:1,minWidth:0}}><textarea className='composer-textarea' aria-label='Composer'/>
            <ClawSidebar threadId='a' flow={flow} disabled={false} onStart={async()=>true} onFollowUp={()=>{}}><PersistentDrawing/></ClawSidebar>
          </section>
          <RightPanelDock hidden={collapsed||focused} resizable={layout.showRightResizeHandle}
            panelRef={layout.rightPanelContainerRef} className={layout.panelClassName} style={layout.panelStyle}
            onResizeStart={layout.handleRightResizeStart} onResize={layout.handleRightResize}
            onResizeEnd={layout.handleRightResizeEnd}>
            <ClawSidebarShell threadId='a' hidden={collapsed||module!=='claw'||focused}/>
            {!collapsed&&module!=='claw'&&!focused&&<section data-standard-panel={module} style={{height:'100%'}}>{module}</section>}
          </RightPanelDock>
          <ResourcePanelOverlay isAgentFocusActive={focused} renderedMainView='thread' renderedPanelThreadId='a'/>
        </main></>
      }
      host.render(<PanelFixture/>);
    `,
      [
        {
          name: "resource-bodies",
          setup(builder) {
            builder.onResolve(
              {
                filter:
                  /^(?:@\/components\/panels\/RightPanel|@\/components\/browser\/useBrowserViewLifecycle)$/
              },
              (args) => ({ path: args.path, namespace: "panel-body-probe" })
            )
            builder.onLoad({ filter: /.*/, namespace: "panel-body-probe" }, (args) => ({
              loader: "tsx",
              resolveDir: resolve("."),
              contents: args.path.endsWith("RightPanel")
                ? "export const RightPanel=({moduleMode})=><p data-overlay-module={moduleMode}>Overlay {moduleMode}</p>"
                : "export const useBrowserViewLifecycle=()=>{}"
            }))
          }
        }
      ]
    )
    const assets = resolve("out/renderer/assets")
    const css =
      existsSync(assets) && readdirSync(assets).find((name) => /^index-.*\.css$/.test(name))
    if (css) await page.addStyleTag({ path: join(assets, css) })
    const sidebar = page.getByRole("complementary", { name: "任务进展", exact: true })
    const shell = page.locator("[data-claw-sidebar-shell]")
    const nav = page.getByRole("navigation", { name: "Panel modules" })
    await nav.getByText("Task", { exact: true }).click()
    await sidebar.getByRole("button", { name: "收起任务进展" }).click()
    assert.equal(await shell.isVisible(), false)
    await nav.getByText("Expand", { exact: true }).click()
    await sidebar.getByRole("tab", { name: "输出与面板" }).click()
    await page.getByLabel("Plugin draft").fill("Local unsaved input")
    await nav.getByText("Collapse", { exact: true }).click()
    assert.equal(await shell.isVisible(), false)
    await nav.getByText("Expand", { exact: true }).click()
    assert.equal(await page.getByLabel("Plugin draft").inputValue(), "Local unsaved input")
    const divider = page.locator('[role="separator"][aria-orientation="vertical"]')
    const drag = async (delta: number, fraction = 0.75) => {
      const handle = (await divider.boundingBox())!
      assert(
        handle && handle.height >= 650,
        "the real pointer target must span the full panel height"
      )
      const x = handle.x + handle.width / 2
      const y = handle.y + handle.height * fraction
      await page.mouse.move(x, y)
      const renders = await page.evaluate("window.shellFixture.renders()")
      await page.mouse.down()
      for (let frame = 1; frame <= 12; frame++) {
        await page.mouse.move(x + (delta * frame) / 12, y)
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        )
      }
      assert.equal(
        await page.evaluate("window.shellFixture.renders()"),
        renders,
        "drag previews must not rerender the parent or plugin tree on every pointer frame"
      )
      await page.mouse.up()
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      )
    }
    await drag(40)
    assert.equal(
      Math.round((await shell.boundingBox())!.width),
      260,
      "task width must use the same resize limits without jumping back to 340"
    )
    mkdirSync("output/mods-task-sidebar-shell", { recursive: true })
    // Same shared dock and real mouse target at desktop and below the former 1050px breakpoint.
    for (const width of [1300, 1000, 800]) {
      await page.setViewportSize({ width, height: 850 })
      await nav.getByText("Task", { exact: true }).click()
      const before = (await shell.boundingBox())!
      await drag(-100, 0.92)
      const expanded = (await shell.boundingBox())!
      assert.equal(Math.round(expanded.width - before.width), 100)
      const chat = (await page.locator("[data-chat-column]").boundingBox())!
      assert(
        chat.x + chat.width <= expanded.x,
        "task sidebar must not overlay the chat at narrow widths"
      )
      for (const mode of ["work", "preview", "git", "browser"]) {
        await nav.getByText(mode, { exact: true }).click()
        const other = (await page.locator("[data-right-panel-dock]").boundingBox())!
        assert.equal(other.y, expanded.y, "all module top edges align")
        assert.equal(other.height, expanded.height, "all module bottom edges align")
        assert.equal(other.x + other.width, expanded.x + expanded.width, "all right edges align")
        await drag(10, 0.1)
        const resized = (await page.locator("[data-right-panel-dock]").boundingBox())!
        assert.equal(
          Math.round(other.width - resized.width),
          10,
          `${mode} still supports real dragging`
        )
      }
      await nav.getByText("Task", { exact: true }).click()
      const taskBeforeShrink = (await shell.boundingBox())!.width
      await drag(20)
      assert.equal(Math.round(taskBeforeShrink - (await shell.boundingBox())!.width), 20)
      await page.screenshot({ path: `output/mods-task-sidebar-shell/sidebar-${width}.png` })
    }
    await page.setViewportSize({ width: 1300, height: 850 })
    for (const mode of ["preview", "git", "browser", "work"]) {
      await nav.getByText("Task", { exact: true }).click()
      await nav.getByText(mode, { exact: true }).click()
      await page.locator(`[data-standard-panel=${mode}]`).waitFor()
      assert.equal(await nav.getByText(mode, { exact: true }).getAttribute("aria-pressed"), "true")
      assert.equal(
        await nav.getByText("Task", { exact: true }).getAttribute("aria-pressed"),
        "false"
      )
      assert.equal(await shell.isVisible(), false)
      assert.equal(
        await page.locator("[data-overlay-module]").count(),
        0,
        "available panel must switch module instead of opening a competing drawer"
      )
    }
    await nav.getByText("Task", { exact: true }).click()
    await sidebar.getByRole("tab", { name: "输出与面板" }).click()
    assert.equal(await page.getByLabel("Plugin draft").inputValue(), "Local unsaved input")
    assert.deepEqual(await page.evaluate("window.shellFixture.counts()"), [1, 0])
    for (const mode of ["browser", "preview"]) {
      await nav.getByText(mode, { exact: true }).click()
      await page.evaluate((mode) => {
        const fixture = (
          window as unknown as { shellFixture: Record<string, (value: boolean) => void> }
        ).shellFixture
        fixture[`${mode}Fullscreen`](true)
      }, mode)
      await page.waitForFunction("window.shellFixture.fullscreen().includes(true)")
      assert(
        ((await page.evaluate("window.shellFixture.fullscreen()")) as boolean[]).includes(true)
      )
      await nav.getByText("Task", { exact: true }).click()
      assert.deepEqual(await page.evaluate("window.shellFixture.fullscreen()"), [false, false])
      assert((await shell.boundingBox())!.width >= 250)
      await nav.getByText(mode, { exact: true }).click()
      assert.deepEqual(
        await page.evaluate("window.shellFixture.fullscreen()"),
        [false, false],
        "returning to a resource must not revive an obsolete fullscreen layout"
      )
    }
    await nav.getByText("Task", { exact: true }).click()
    mkdirSync("output/mods-task-sidebar-shell", { recursive: true })
    await page.screenshot({ path: "output/mods-task-sidebar-shell/sidebar.png" })
    await page.evaluate("window.shellFixture.focus(true)")
    await nav.getByText("preview", { exact: true }).click()
    await page.locator("[data-overlay-module=preview]").waitFor()
    assert.equal(
      await nav.getByText("Task", { exact: true }).getAttribute("aria-pressed"),
      "true",
      "focus mode keeps its underlying module while using the existing resource drawer"
    )
    assert.deepEqual(errors, [])
    console.log(
      "PASS task sidebar: real pointer resize at 1300/1000/800px, aligned dock edges, no per-frame parent renders, collapse/input retention, four module switches and focus drawer"
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
