/** Real Bot creation/edit controls and catalog; synthetic persistence, no user data or models. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { build } from "esbuild"
import { chromium } from "playwright"
import type { BotDefinition, CreateBotInput, UpdateBotInput } from "../src/shared/bots/contracts"

type FixtureWindow = Window & {
  fixture: {
    saved: BotDefinition | null
    creates: CreateBotInput[]
    updates: UpdateBotInput[]
    fail: boolean
    failCatalog: boolean
    invalidate(): void
  }
}

async function main() {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import {BotEditor} from "./src/renderer/src/components/bots/BotEditor";
import {configureAppCatalogLoaders,invalidateSkillCatalog} from "./src/renderer/src/lib/app-catalog-cache";
const f=window.fixture={saved:null,creates:[],updates:[],fail:false,failCatalog:false,invalidate:invalidateSkillCatalog};
const skill=name=>({name,id:name,path:"/synthetic/"+name+"/SKILL.md",description:name+" fixture"});
configureAppCatalogLoaders({skills:async()=>{if(f.failCatalog)throw new Error("offline");return {
 localSkills:[skill("review"),skill("deploy"),skill("disabled")],pluginSkills:[{...skill("review"),id:"plugin/review",pluginId:"plugin"}],disabledSkillIds:["disabled"]
}},plugins:async()=>[]});
const client={hostId:"local",
 create:async input=>{f.creates.push(input);return {...input,id:"a",hostId:"local",threadId:"t",archived:false,version:1,createdAt:1,updatedAt:1}},
 update:async input=>{f.updates.push(input);if(f.fail){f.fail=false;throw new Error("请先停止当前任务，再修改 Bot")};return {...f.saved,...input,version:input.expectedVersion+1}}
};
function App(){const [open,setOpen]=useState(true),[bot,setBot]=useState(null),[key,setKey]=useState(0);
 const edit=()=>{setBot(f.saved);setKey(v=>v+1);setOpen(true)};
 return <><button onClick={edit}>重新编辑</button><button onClick={()=>{f.saved.allowedSkillNames=["missing-template-skill"];edit()}}>载入模板选择</button>
 {open&&<BotEditor key={key} client={client} bot={bot} onClose={()=>setOpen(false)} onSaved={saved=>{f.saved=saved;setOpen(false)}}/>}</>}
createRoot(document.getElementById("root")).render(<App/>);
`
    },
    plugins: [
      {
        name: "synthetic-shell",
        setup(build) {
          const mocks: Record<string, string> = {
            "@/lib/store":
              "const state={models:[],pluginVersion:0,loadModels:async()=>{}};export const useAppStore=Object.assign(select=>select(state),{getState:()=>state});",
            "@/components/chat/CustomModelDialog": "export const CustomModelDialog=()=>null;",
            "./BotAvatar": "export const BotAvatar=()=>null;",
            "./BotAppearancePicker": "export const BotAppearancePicker=()=>null;"
          }
          build.onResolve({ filter: /.*/ }, (args) =>
            args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined
          )
          build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents: mocks[args.path],
            loader: "tsx"
          }))
        }
      }
    ],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": process.cwd() + "/src/renderer/src" },
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const browser = await chromium.launch({
    ...(!existsSync(chromium.executablePath()) ? { channel: "chrome" } : {}),
    headless: true
  })
  try {
    const page = await browser.newPage({ viewport: { width: 440, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: result.outputFiles[0].text })
    await page.getByRole("textbox", { name: "Bot 名称" }).fill("Reviewer")
    await page.getByRole("button", { name: "更多设置" }).click()
    const setting = page.getByRole("combobox", { name: "技能范围" })
    assert.equal(await setting.inputValue(), "all")
    await setting.selectOption("selected")
    await page.getByRole("checkbox", { name: /^review/ }).check()
    assert.equal(await page.getByRole("checkbox", { name: /^review/ }).count(), 1)
    assert.equal(await page.getByRole("checkbox", { name: /^disabled/ }).isDisabled(), true)
    await page.getByRole("button", { name: "创建", exact: true }).click()
    await page.waitForFunction(() => !!(window as FixtureWindow).fixture.saved)
    assert.deepEqual(
      await page.evaluate(() => (window as FixtureWindow).fixture.creates[0].allowedSkillNames),
      ["review"]
    )
    await page.getByRole("button", { name: "重新编辑" }).click()
    assert.equal(await setting.inputValue(), "selected")
    assert.equal(await page.getByRole("checkbox", { name: /^review/ }).isChecked(), true)
    await page.getByRole("checkbox", { name: /^review/ }).uncheck()
    await page.evaluate(() => {
      ;(window as FixtureWindow).fixture.fail = true
    })
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "请先停止当前任务" }).waitFor()
    assert.deepEqual(
      await page.evaluate(() => (window as FixtureWindow).fixture.saved?.allowedSkillNames),
      ["review"]
    )
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction(
      () => (window as FixtureWindow).fixture.saved?.allowedSkillNames?.length === 0
    )
    await page.getByRole("button", { name: "载入模板选择" }).click()
    await page.getByRole("checkbox", { name: /^missing-template-skill/ }).waitFor()
    assert.equal(
      await page.getByRole("checkbox", { name: /^missing-template-skill/ }).isChecked(),
      true
    )
    await page.evaluate(() => {
      const f = (window as FixtureWindow).fixture
      f.failCatalog = true
      f.invalidate()
    })
    await page.getByRole("alert").filter({ hasText: "技能列表加载失败" }).waitFor()
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction(() => (window as FixtureWindow).fixture.updates.length === 3)
    assert.deepEqual(
      await page.evaluate(() => (window as FixtureWindow).fixture.saved?.allowedSkillNames),
      ["missing-template-skill"]
    )
    await page.getByRole("button", { name: "重新编辑" }).click()
    await setting.selectOption("all")
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction(
      () => (window as FixtureWindow).fixture.saved?.allowedSkillNames === null
    )
    assert.deepEqual(errors, [])
    console.log(
      "Bot skill settings: default, creation, edit, none/all, duplicate names, disabled/missing skills and failed save/catalog passed"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
