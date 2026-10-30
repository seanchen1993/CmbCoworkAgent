import assert from "node:assert/strict"
import { build } from "esbuild"
import { chromium } from "playwright"

import { fileURLToPath } from "node:url"
const root = fileURLToPath(new URL("../", import.meta.url))
const fixture = `
import { createRoot } from "react-dom/client";
import { CustomModelDialog } from "./src/renderer/src/components/chat/CustomModelDialog";
const configs=[{id:"chat", name:"Main chat",baseUrl:"https://example.test/v1",model:"text-model",hasApiKey:true},{id:"vision",name:"Image model",baseUrl:"https://example.test/llm/image-model/v1",model:"image-model",hasApiKey:true},{id:"nokey",name:"Missing key",baseUrl:"https://example.test/v1",model:"other",hasApiKey:false}];
const calls=[]; let vision=""; let fail=false;
Object.assign(window,{visionFixture:{calls,fail:()=>{fail=true}},api:{models:{getTokenLimits:async()=>({defaultMaxTokens:128000,minMaxTokens:32000,maxMaxTokens:1000000,defaultMaxOutputTokens:8192,minMaxOutputTokens:1,maxMaxOutputTokens:100000,defaultTemperature:0.1,maxTemperature:2,defaultTopP:0.95,maxTopP:1,defaultTopK:40,minTopK:0,maxTopK:1000}),getBuiltinConfigs:async()=>[],getCustomConfigs:async()=>configs,getDefault:async()=>"custom:chat",getVision:async()=>vision,setVision:async(ref)=>{calls.push(["setVision",ref]);if(fail)throw Error("设置失败测试"); vision=ref; return ref},setDefault:async(ref)=>{calls.push(["setDefault",ref])}}}});
createRoot(document.getElementById("root")).render(<CustomModelDialog open={true} selectedModelId="custom:chat" onOpenChange={()=>{}}/>);
`
const bundle = await build({
  stdin: { contents: fixture, resolveDir: root, loader: "tsx" },
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  jsx: "automatic",
  alias: { "@": `${root}/src/renderer/src` },
  define: { "process.env.NODE_ENV": '"production"' }
})
const browser = await chromium.launch({
  executablePath: process.env.VISION_TEST_CHROMIUM || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"]
})
try {
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const select = page.getByLabel("多模态模型（共享图片分析）")
  await select.waitFor()
  await page.waitForFunction(
    () => document.querySelector("#vision-model-role").options.length === 4
  )
  assert.equal(await select.inputValue(), "")
  assert.equal(await select.locator('option[value="custom:nokey"]').isDisabled(), true)
  await select.selectOption("custom:vision")
  await page.waitForFunction(
    () =>
      document.querySelector("#vision-model-role").value === "custom:vision" &&
      !document.querySelector("#vision-model-role").disabled
  )
  await select.selectOption("")
  await page.waitForFunction(() => !document.querySelector("#vision-model-role").disabled)
  await page.evaluate(() => window.visionFixture.fail())
  await select.selectOption("custom:vision")
  await page.getByText("设置失败测试", { exact: true }).waitFor()
  assert.equal(await select.inputValue(), "")
  const calls = await page.evaluate(() => window.visionFixture.calls)
  assert.deepEqual(calls, [
    ["setVision", "custom:vision"],
    ["setVision", ""],
    ["setVision", "custom:vision"]
  ])
  assert.deepEqual(errors, [])
  console.log(
    "PASS real CustomModelDialog mounted in Chromium: initial disabled, missing-key option disabled, enable, disable, failed save retained prior selection, no setDefault call, no browser errors"
  )
} finally {
  await browser.close()
}
