/** Unbound conversations must explain directory selection once and never expose a denied fallback. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  try {
    const page = await browser.newPage()
    await mount(page, `
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      let sends=0,admit;
      function Fixture(){const [ready,setReady]=useState(false);admit=()=>setReady(true);
        return <ModsChatScope.Provider value={{threadId:'plain',enabled:false,ready,
          error:ready?undefined:'请先选择工作目录，再开始对话或创作。',isCurrent:()=>ready}}>
          <FunctionSite threadId='plain' component='AbovePrompt' facts={{}}/>
          <FunctionSite threadId='plain' component='InfoNotice' facts={{}}
            fallback={<button onClick={()=>sends++}>原生发送</button>}/>
          <FunctionSite threadId='plain' component='PromptHint' facts={{}}/>
        </ModsChatScope.Provider>}
      window.unboundFixture={admit:()=>admit(),sends:()=>sends};host.render(<Fixture/>);
    `, [browserWorkerPlugin()])
    await page.getByRole("alert").waitFor()
    assert.equal(await page.getByRole("alert").count(), 1)
    assert.equal(await page.getByRole("button", { name: "原生发送", exact: true }).count(), 0)
    assert.equal(await page.evaluate("window.unboundFixture.sends()"), 0)
    await page.evaluate("window.unboundFixture.admit()")
    await page.getByRole("button", { name: "原生发送", exact: true }).click()
    assert.equal(await page.getByRole("alert").count(), 0)
    assert.equal(await page.evaluate("window.unboundFixture.sends()"), 1)
    console.log("PASS unbound conversation: one directory hint; denied native fallback stays blocked")
  } finally { await browser.close() }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
