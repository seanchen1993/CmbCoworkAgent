/** Real project consent/configuration controls, including the mutation driver's public-field saves. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import type { LocalProjectView } from "../src/shared/project-runtime/platform-api"
import { saveMutationProjectConfigurationViaUi } from "./support/autobiz-composition-mutation-creator"

interface FixtureWindow {
  projectConfig: {
    saves: Array<{ key: string; value: string | number; workspace: string; revision: number }>
    approvals: number
    readyCalls: number
    reviewReads: number
    holdReview(): void
    releaseReview(missing: boolean): void
    changeSource(): void
    scope(projectId: string, version: number, missing: boolean): void
  }
}

async function main() {
  const bundled = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [
      {
        name: "project-config-owned-store",
        setup(builder) {
          builder.onResolve({ filter: /(?:^@\/lib\/store$|^\.\/store$)/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "js",
            contents: `const state={accountRevision:0,threads:[]};
            export const useAppStore=selector=>selector(state);useAppStore.getState=()=>state;`
          }))
        }
      }
    ],
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
      import React from'react';import{createRoot}from'react-dom/client';
      import{ProjectFunctionConsent}from'./src/renderer/src/components/harness-board/ProjectFunctionConsent';
      let projectId='project-a',version=1,sourceDigest='a'.repeat(64),missing=false,revision=0;
      let held=false,release;const values={e2eScript:'tests/e2e.mjs',e2eSubjects:'["original"]',iterations:1};
      const fixture={saves:[],approvals:0,readyCalls:0,reviewReads:0,
        holdReview:()=>held=true,releaseReview:next=>{missing=next;held=false;release?.()},
        changeSource:()=>sourceDigest='b'.repeat(64),
        scope:(id,nextVersion,nextMissing)=>{projectId=id;version=nextVersion;missing=nextMissing;render()}};
      const workspace='C:/target-project';
      const review=()=>({projectId,projectVersion:version,workspace,packageDigest:sourceDigest,
        workspaceEnabled:true,globallyEnabled:true,
        source:{pluginId:'main-source',name:'configured-project',digest:sourceDigest,state:'ready',
          capabilities:[],scannedMethods:[],scanIncomplete:false,hasConfiguration:true,configurationReady:!missing}});
      const config=()=>({pluginId:'main-source',plugin:'configured-project',workspace,digest:sourceDigest,
        savedRevision:revision,state:'inactive',fields:Object.entries(values).map(([key,value])=>({
          key,label:key,description:'Public target project input',type:key==='iterations'?'number':'string',
          supported:true,required:true,value}))});
      const configApi={userConfig:async(id,pluginId)=>{if(id!==projectId||pluginId!=='main-source')throw Error('WRONG_CONFIG_SCOPE');return config()},
        saveUserConfig:async(id,view,key,value)=>{
          if(id!==projectId||view.workspace!==workspace||view.digest!==sourceDigest||view.savedRevision!==revision)throw Error('STALE_CONFIG');
          if(key==='iterations'&&typeof value!=='number')throw Error('WRONG_NUMBER_TYPE');
          values[key]=value;revision++;fixture.saves.push({key,value,workspace,revision});return config()
        }};
      window.api={mods:{onConfigurationChanged:()=>()=>{}},harnessBoard:{localProjects:{mods:{
        read:async id=>{if(id!==projectId)throw Error('WRONG_PROJECT');fixture.reviewReads++;
          if(held)await new Promise(resolve=>release=resolve);return review()},
        approve:async()=>{fixture.approvals++;throw Error('UNEXPECTED_APPROVAL')},config:configApi}}}};
      window.projectConfig=fixture;const root=createRoot(document.getElementById('root'));
      function render(){root.render(<ProjectFunctionConsent projectId={projectId} version={version}
        onReady={()=>fixture.readyCalls++}/>)}render();
      `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    const region = page.getByRole("region", { name: "本包功能权限", exact: true })
    const settings = region.locator(":scope > details")
    const summary = settings.locator(":scope > summary")
    const form = region.locator('[data-function-user-config="main-source"]')
    const tick = () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      )
    await summary.waitFor()
    await tick()
    assert.equal(
      await settings.evaluate((element) => (element as HTMLDetailsElement).open),
      false,
      "an initially ready project starts collapsed"
    )
    await summary.click()
    await form.locator(":scope > summary").click()
    const saveField = async (key: string, value: string, expectedSaves: number) => {
      const readyCalls = await page.evaluate(
        () => (window as unknown as FixtureWindow).projectConfig.readyCalls
      )
      const control = form.locator(`[id=${JSON.stringify(`plugin-param-main-source-${key}`)}]`)
      await control.fill(value)
      await control
        .locator("xpath=../..")
        .getByRole("button", { name: "保存", exact: true })
        .click()
      await page.waitForFunction(
        ({ expectedSaves, readyCalls }) => {
          const fixture = (window as unknown as FixtureWindow).projectConfig
          return fixture.saves.length === expectedSaves && fixture.readyCalls > readyCalls
        },
        { expectedSaves, readyCalls }
      )
      await tick()
      assert.equal(
        await settings.evaluate((element) => (element as HTMLDetailsElement).open),
        true,
        "saving a configured field must preserve the user's expanded project panel"
      )
      assert.equal(await form.evaluate((element) => (element as HTMLDetailsElement).open), true)
    }
    await saveField("e2eScript", "tests/changed.mjs", 1)
    await saveField("e2eSubjects", '["changed"]', 2)

    const records: Record<string, unknown>[] = []
    await saveMutationProjectConfigurationViaUi({
      page,
      view: {
        project: { projectId: "project-a", workspace: "C:/target-project" }
      } as LocalProjectView,
      values: { e2eScript: "tests/driver.mjs", e2eSubjects: '["driver"]', iterations: 2 },
      record: (value) => records.push(value)
    })
    await tick()
    const saves = await page.evaluate(
      () => (window as unknown as FixtureWindow).projectConfig.saves
    )
    assert.deepEqual(
      saves.map((value) => [value.key, value.value]),
      [
        ["e2eScript", "tests/changed.mjs"],
        ["e2eSubjects", '["changed"]'],
        ["e2eScript", "tests/driver.mjs"],
        ["e2eSubjects", '["driver"]'],
        ["iterations", 2]
      ]
    )
    assert(saves.every((value) => value.workspace === "C:/target-project"))
    assert.equal(records.length, 3)
    assert.equal(await settings.evaluate((element) => (element as HTMLDetailsElement).open), true)

    // A late review that changes readiness still surfaces required configuration after a close.
    await page.evaluate(() => (window as unknown as FixtureWindow).projectConfig.holdReview())
    const reads = await page.evaluate(
      () => (window as unknown as FixtureWindow).projectConfig.reviewReads
    )
    await region.getByRole("button", { name: "重新核对", exact: true }).click()
    await page.waitForFunction(
      (reads) => (window as unknown as FixtureWindow).projectConfig.reviewReads > reads,
      reads
    )
    await summary.click()
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).projectConfig.releaseReview(true)
    )
    await page.waitForFunction(() => {
      const settings = document.querySelector('section[aria-label="本包功能权限"] > details')
      return settings instanceof HTMLDetailsElement && settings.open
    })
    await region.getByRole("alert").filter({ hasText: "请先补齐上方必填参数" }).waitFor()

    // The existing project/version key and a changed retained source each reset expansion.
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).projectConfig.scope("project-b", 2, false)
    )
    await tick()
    assert.equal(await settings.evaluate((element) => (element as HTMLDetailsElement).open), false)
    await summary.click()
    await page.evaluate(() => (window as unknown as FixtureWindow).projectConfig.changeSource())
    await region.getByRole("button", { name: "重新核对", exact: true }).click()
    await tick()
    assert.equal(
      await settings.evaluate((element) => (element as HTMLDetailsElement).open),
      false,
      "an expanded old source cannot determine the default for a new retained source"
    )
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).projectConfig.scope("project-c", 3, true)
    )
    await region.getByRole("alert").filter({ hasText: "请先补齐上方必填参数" }).waitFor()
    assert.equal(await settings.evaluate((element) => (element as HTMLDetailsElement).open), true)
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).projectConfig.approvals),
      0
    )
    assert.deepEqual(errors, [])
    console.log(
      "PASS real project consent preserves multi-field edits, surfaces new requirements and resets source/version scopes; mutation driver saves every public value with native readback"
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
