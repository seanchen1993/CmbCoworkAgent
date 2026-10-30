import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { chromium } from "playwright"

const root = fileURLToPath(new URL("../", import.meta.url))
// Mount the actual ModelSwitcher and CustomModelDialog together. Only their
// store/IPC boundary is mocked, so a mistaken onModelSaved callback changes the
// current model just as it does in the application.
const stateModule = `
import { useSyncExternalStore } from "react";
import { create } from "zustand";
const limits={defaultMaxTokens:128000,minMaxTokens:32000,maxMaxTokens:1000000,defaultMaxOutputTokens:8192,minMaxOutputTokens:1,maxMaxOutputTokens:100000,defaultTemperature:0.1,maxTemperature:2,defaultTopP:0.95,maxTopP:1,defaultTopK:40,minTopK:0,maxTopK:1000};
const initialConfigs=[{id:"chat",name:"Main chat",baseUrl:"https://example.test/v1",model:"text-model",hasApiKey:true},{id:"vision",name:"Image model",baseUrl:"https://example.test/llm/image-model/v1",model:"image-model",hasApiKey:true},{id:"nokey",name:"Missing key",baseUrl:"https://example.test/v1",model:"other",hasApiKey:false}];
let configs=[],vision="",defaultModel="",currentModel="",calls=[],failVision=0,nextId=0;
const listeners=new Set();
let catalog={routingMode:"pinned",defaultModelId:""};
const emit=()=>listeners.forEach(listener=>listener());
const modelList=()=>configs.map(item=>({id:"custom:"+item.id,name:item.name,model:item.model,source:"custom",provider:"custom",available:item.hasApiKey,tier:"premium"}));
const publishModels=()=>{catalog={routingMode:"pinned",defaultModelId:defaultModel};useAppStore.setState({models:modelList()});emit()};
export const useAppStore=create(()=>({models:[],threads:[{thread_id:"vision-test",metadata:{}}],loadModels:async()=>publishModels()}));
export const actions={restoreCurrentModel(id){currentModel=id;emit()},setCurrentModel(id){calls.push(["setCurrentModel",id]);actions.restoreCurrentModel(id)}};
export const useThreadActions=()=>actions;
export const subscribeModelCatalog=listener=>{listeners.add(listener);return()=>listeners.delete(listener)};
export const readModelCatalogCache=()=>catalog;
export const invalidateModelCatalogCache=()=>{};
export const updateCachedRoutingMode=mode=>{catalog={...catalog,routingMode:mode};emit()};
export function useThreadStateSelector(_threadId,selector){return useSyncExternalStore(subscribeModelCatalog,()=>selector({currentModel,routingResult:null}))}
export function reset(options={}){configs=structuredClone(options.configs??initialConfigs);vision=options.vision??"";defaultModel=options.defaultModel??"custom:chat";currentModel=options.currentModel??"custom:chat";calls=[];failVision=0;nextId=0;publishModels()}
export const read=()=>({currentModel,defaultModel,vision,calls:structuredClone(calls),configs:structuredClone(configs)});
export const failNextVision=()=>{failVision=1};
Object.assign(window,{api:{routing:{setMode:async()=>{}},scheduledTasks:{list:async()=>[]},models:{
 getTokenLimits:async()=>limits,getBuiltinConfigs:async()=>[],getCustomConfigs:async()=>structuredClone(configs),getDefault:async()=>defaultModel,getVision:async()=>vision,
 setVision:async(ref)=>{calls.push(["setVision",ref]);if(failVision){failVision--;throw Error("设置失败测试")}vision=ref;return ref},
 setDefault:async(ref)=>{calls.push(["setDefault",ref]);defaultModel=ref;publishModels()},
 upsertCustomConfig:async(input)=>{const id=input.id??("created-"+(++nextId));calls.push(["upsert",id]);const previous=configs.find(item=>item.id===id);const item={...previous,...input,id,hasApiKey:Boolean(input.apiKey||previous?.hasApiKey)};delete item.apiKey;configs=configs.filter(item=>item.id!==id).concat(item);publishModels();return{id}},
 deleteCustomConfig:async(id)=>{calls.push(["delete",id]);configs=configs.filter(item=>item.id!==id);if(vision==="custom:"+id)vision="";publishModels()}
}}});
`
const fixture = `
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useState } from "react";
import { ModelSwitcher } from "./src/renderer/src/components/chat/ModelSwitcher";
import { CustomModelDialog } from "./src/renderer/src/components/chat/CustomModelDialog";
import * as state from "vision-fixture-state";
const root=createRoot(document.getElementById("root"));
function DialogHarness(){const[open,setOpen]=useState(true);return <CustomModelDialog open={open} selectedModelId={state.read().currentModel||undefined} onModelSaved={state.actions.setCurrentModel} onOpenChange={setOpen}/>}
Object.assign(window,{visionFixture:{read:state.read,failNextVision:state.failNextVision,mount:(options={},dialogOnly=false)=>{flushSync(()=>root.render(null));state.reset(options);flushSync(()=>root.render(dialogOnly?<DialogHarness/>:<ModelSwitcher threadId="vision-test"/>))}}});
`
const bundle = await build({
  stdin: { contents: fixture, resolveDir: root, loader: "tsx" },
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  jsx: "automatic",
  alias: { "@": `${root}/src/renderer/src` },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "vision-state-boundary",
      setup(build) {
        build.onResolve(
          { filter: /^(vision-fixture-state|@\/lib\/(store|thread-context|model-catalog-cache))$/ },
          () => ({ path: "state", namespace: "vision-fixture" })
        )
        build.onLoad({ filter: /.*/, namespace: "vision-fixture" }, () => ({
          contents: stateModule,
          loader: "js",
          resolveDir: root
        }))
      }
    }
  ]
})
const browser = await chromium.launch({
  executablePath: process.env.VISION_TEST_CHROMIUM || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"]
})
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(10_000)
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const read = () => page.evaluate(() => window.visionFixture.read())
  const mount = async (options = {}, dialogOnly = false) => {
    await page.evaluate(
      ({ options, dialogOnly }) => window.visionFixture.mount(options, dialogOnly),
      { options, dialogOnly }
    )
    if (!dialogOnly) {
      const current = (await read()).currentModel
      const name = (await read()).configs.find((item) => "custom:" + item.id === current)?.name
      await page.getByRole("button", { name: name || "选择模型", exact: true }).click()
      await page.getByRole("button", { name: "编辑模型配置", exact: true }).click()
    }
    await page.waitForFunction(
      () => document.querySelector("#vision-model-role")?.options.length > 0
    )
  }
  const field = (name) => page.getByText(name, { exact: true }).locator("..").locator("input")
  const fillNew = async (name = "New vision") => {
    await field("显示名称").fill(name)
    await field("接口地址（Base URL）").fill("https://example.test/llm/image-model/v1")
    await field("模型名称（Model）").fill("image-model")
    await field("API 密钥").fill("mock-vision-key")
  }
  const select = page.getByLabel("多模态模型（共享图片分析）")
  const assertChatPreserved = async (expectedVision) => {
    const state = await read()
    assert.equal(state.currentModel, "custom:chat")
    assert.equal(state.defaultModel, "custom:chat")
    assert.equal(state.vision, expectedVision)
    assert.deepEqual(
      state.calls.filter(([name]) => name === "setCurrentModel" || name === "setDefault"),
      []
    )
  }
  const saveVision = async () => {
    await page.getByRole("button", { name: "保存并用于图片分析", exact: true }).click()
    await page.getByRole("dialog").waitFor({ state: "hidden" })
  }

  // Selecting, switching, disabling, and a failed role save remain independent
  // from chat selection and defaults, including the real parent callback.
  await mount()
  await page.waitForFunction(
    () => document.querySelector("#vision-model-role").options.length === 4
  )
  assert.equal(await select.inputValue(), "")
  assert.equal(await select.locator('option[value="custom:nokey"]').isDisabled(), true)
  for (const ref of ["custom:vision", "custom:chat", ""]) {
    await select.selectOption(ref)
    await page.waitForFunction(
      (ref) =>
        document.querySelector("#vision-model-role").value === ref &&
        !document.querySelector("#vision-model-role").disabled,
      ref
    )
    await assertChatPreserved(ref)
  }
  await page.evaluate(() => window.visionFixture.failNextVision())
  await select.selectOption("custom:vision")
  await page.getByText("设置失败测试", { exact: true }).waitFor()
  assert.equal(await select.inputValue(), "")
  await assertChatPreserved("")
  console.log(
    "PASS role selection, switching, disabling, missing-key gate and failure preserve current/default chat"
  )

  await mount()
  await page.getByRole("button", { name: "新增多模态模型", exact: true }).click()
  await fillNew()
  assert.equal(await page.getByText("默认使用", { exact: true }).count(), 0)
  await saveVision()
  await assertChatPreserved("custom:created-1")
  console.log(
    "PASS create and bind a vision model through the real ModelSwitcher without selecting it for chat"
  )

  for (const viaRoleButton of [true, false]) {
    await mount({ vision: "custom:vision" })
    await page
      .getByRole("button", { name: viaRoleButton ? "编辑多模态模型" : "Image model", exact: true })
      .click()
    await field("显示名称").fill("Edited vision")
    assert.equal(await page.getByText("默认使用", { exact: true }).count(), 0)
    await saveVision()
    await assertChatPreserved("custom:vision")
    assert.equal((await read()).configs.find((item) => item.id === "vision").name, "Edited vision")
  }
  console.log(
    "PASS edit a selected vision model from the role button or ordinary model list without changing chat/default"
  )

  await mount({ vision: "custom:vision" })
  await page.getByRole("button", { name: "新增多模态模型", exact: true }).click()
  await fillNew()
  await page.evaluate(() => window.visionFixture.failNextVision())
  await page.getByRole("button", { name: "保存并用于图片分析", exact: true }).click()
  await page.getByText("设置失败测试", { exact: true }).waitFor()
  await assertChatPreserved("custom:vision")
  assert.equal((await read()).configs.length, 4)
  await saveVision()
  await assertChatPreserved("custom:created-1")
  assert.equal((await read()).configs.length, 4)
  assert.deepEqual(
    (await read()).calls.filter(([name]) => name === "upsert"),
    [
      ["upsert", "created-1"],
      ["upsert", "created-1"]
    ]
  )
  console.log(
    "PASS failed vision-role save and retry preserve chat/default and reuse the already saved model"
  )

  await mount({ configs: [], currentModel: "", defaultModel: "" }, true)
  await page.getByRole("button", { name: "新增多模态模型", exact: true }).click()
  await fillNew()
  await saveVision()
  let state = await read()
  assert.equal(state.currentModel, "")
  assert.equal(state.defaultModel, "")
  assert.equal(state.vision, "custom:created-1")
  assert.deepEqual(
    state.calls.filter(([name]) => name === "setCurrentModel" || name === "setDefault"),
    []
  )
  console.log("PASS first-ever vision model does not write a default or select a chat model")

  await mount({ vision: "custom:vision" })
  await page.getByRole("button", { name: "编辑多模态模型", exact: true }).click()
  await page.getByRole("button", { name: "删除", exact: true }).click()
  await page.waitForFunction(
    () => !window.visionFixture.read().configs.some((item) => item.id === "vision")
  )
  await assertChatPreserved("")
  console.log("PASS deleting a separate vision model does not activate a fallback chat model")

  await mount()
  await page.getByRole("button", { name: "新增", exact: true }).click()
  await fillNew("New chat")
  await page.getByRole("button", { name: "保存", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  state = await read()
  assert.equal(state.currentModel, "custom:created-1")
  assert.equal(state.defaultModel, "custom:chat")
  assert.equal(state.vision, "")
  assert.deepEqual(
    state.calls.filter(([name]) => name === "setCurrentModel"),
    [["setCurrentModel", "custom:created-1"]]
  )
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await page.getByRole("button", { name: /Main chat/ }).click()
  assert.equal((await read()).currentModel, "custom:chat")
  console.log(
    "PASS ordinary model creation still activates the saved model and direct chat selection still works"
  )

  await mount()
  await page.getByRole("button", { name: "Image model", exact: true }).click()
  await page.getByText("默认使用", { exact: true }).locator("..").getByRole("switch").click()
  await page.getByRole("button", { name: "保存", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  state = await read()
  assert.equal(state.currentModel, "custom:vision")
  assert.equal(state.defaultModel, "custom:vision")
  assert.equal(state.vision, "")
  assert.deepEqual(
    state.calls.filter(([name]) => name === "setDefault"),
    [["setDefault", "custom:vision"]]
  )
  console.log("PASS explicit ordinary-model default changes remain supported")

  await mount({ configs: [], currentModel: "", defaultModel: "" }, true)
  await fillNew("First chat")
  await page.getByRole("button", { name: "保存", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  state = await read()
  assert.equal(state.currentModel, "custom:created-1")
  assert.equal(state.defaultModel, "custom:created-1")
  assert.equal(state.vision, "")
  console.log("PASS first ordinary model keeps its existing selection/default behavior")
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
}
