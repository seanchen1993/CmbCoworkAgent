import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"

export async function verifyFileWrite(
  app: ElectronApplication,
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "file-write-project")
  mkdirSync(project)
  writeFileSync(join(project, "claw-notes"), "ORIGINAL_WRITE_CONTROL_READ")
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "File write E2E",
      workspacePath: project,
      agentMode: "normal"
    })
    const id =
      (thread as unknown as { thread_id?: string; id: string }).thread_id ??
      (thread as unknown as { id: string }).id
    await window.api.workspace.set(id, project)
    await window.api.threads.patchMetadata(id, {
      set: { model: "custom:mods-model-fixture", subagentsEnabled: false }
    })
    await window.api.mods.configure(id, true, true)
    return id
  }, project)
  const zip = new AdmZip()
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: "file-write", version: "1.0.0" })))
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"write-sdk",description:"Native file write"});
      await $.command.register({name:"write-immediate",description:"Read only write probe",immediate:true});return next(e)
    });
    on("fs.write",async($,e,next)=>{
      if(e.path.endsWith("original.md"))return next({...e,path:"nested/written.md",text:e.text+"!"});
      if(e.path.endsWith("delayed.md")){$.ui.log("WRITE_WAIT");await $.clock.sleep(1500)}
      return next(e)
    });
    on("tool.call",async($,e,next)=>{
      if(e.tool==="read_file"&&String(e.file_path).endsWith("claw-notes")){
        try{await $.fs.write("automatic.md","unexpected");$.ui.log("AUTOMATIC_WRITE_UNEXPECTED")}
        catch(error){$.ui.log("AUTOMATIC_WRITE_ERROR:"+(error.code||error.message))}
      }
      return next(e)
    });
    on("command.run",async($,e)=>{
      if(e.command!=="write-sdk"&&e.command!=="write-immediate")return {};
      try{
        const path=e.args==="normal"?"original.md":e.args+".md";
        const value=await $.fs.write(path,"REAL_NATIVE_WRITE");
        return {text:"WRITE_DONE:"+e.args+":"+String(value)}
      }catch(error){return {text:"WRITE_ERROR:"+e.args+":"+(error.code||error.message)}}
    })
  }`)
  )
  const installed = await page.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "file-write.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "file-write"
  )!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("File write E2E", { exact: true }).first().click()
  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as {
      writeOriginalDialog: typeof dialog.showMessageBox
      writeApprovals: string[]
    }
    state.writeOriginalDialog = dialog.showMessageBox
    state.writeApprovals = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const text = JSON.stringify(args.slice(1))
      state.writeApprovals.push(text)
      return { response: text.includes("written.md") ? 1 : 0, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
  const composer = page.locator("textarea.composer-textarea")
  const send = async (text: string) => {
    await composer.fill(text)
    await page.locator("form").filter({ has: composer }).locator('button[type="submit"]').click()
  }
  const jobs = () => page.evaluate((id) => window.api.mods.jobs(id), id)
  const command = async (name: string, args: string) => {
    const previous = new Set((await jobs()).map((job) => job.id))
    await send("/" + name + " " + args)
    await until(
      async () =>
        (await jobs()).some(
          (job) => !previous.has(job.id) && job.state !== "running" && job.state !== "queued"
        ),
      "file write command settled"
    )
    const job = (await jobs()).find((job) => !previous.has(job.id))!
    return job.result?.text ?? job.error
  }
  const before = requests.length
  try {
    assert.equal(await command("write-sdk", "normal"), "WRITE_DONE:normal:undefined")
    assert.equal(readFileSync(join(project, "nested/written.md"), "utf8"), "REAL_NATIVE_WRITE!")
    assert(!existsSync(join(project, "original.md")))
    const receipts = (await page.evaluate((id) => window.api.mods.audit(id), id)).filter(
      (row) => row.toolId === "host:write_file" && row.status === "succeeded"
    )
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].identity?.modId, "function:file-write")
    assert.equal(receipts[0].identity?.threadId, id)
    assert(receipts[0].finalArgsHash)
    const approvals = await app.evaluate(
      () => (globalThis as unknown as { writeApprovals: string[] }).writeApprovals
    )
    assert(
      approvals.some((text) => text.includes("written.md") && text.includes("REAL_NATIVE_WRITE!"))
    )
    assert.equal(requests.length, before)
    writeFileSync(
      join(artifacts, "file-write-receipts.json"),
      JSON.stringify({ receipts, approvals }, null, 2)
    )
    await page.screenshot({ path: join(artifacts, "file-write.png") })
    pass(
      "fs.write writes the actual rewritten file once through the original approval and durable host receipt without a model"
    )
    assert.equal(await command("write-sdk", "denied"), "WRITE_ERROR:denied:MODS_USER_REJECTED")
    assert(!existsSync(join(project, "denied.md")))
    pass("original native approval rejection prevents the SDK filesystem side effect")
    assert.equal(
      await command("write-immediate", "readonly"),
      "WRITE_ERROR:readonly:MODS_WRITE_REQUIRES_USER_ACTION"
    )
    assert(!existsSync(join(project, "readonly.md")))
    pass("immediate read-only commands cannot gain write permission through the file SDK")
    await send("[mods-tool-rewrite]")
    await until(
      async () =>
        (await page.getByText("MODEL_TOOL_HOOK_OK", { exact: true }).count()) > 0 &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "original model read after automatic write denial"
    )
    const logs = await page.evaluate((id) => window.api.mods.logs(id), id)
    assert(logs.some((row) => row.text === "AUTOMATIC_WRITE_ERROR:MODS_WRITE_REQUIRES_USER_ACTION"))
    assert(!existsSync(join(project, "automatic.md")))
    pass(
      "automatic model hooks retain the original user-action requirement while native reads continue"
    )
    await send("/write-sdk delayed")
    await until(
      async () =>
        (await page.evaluate((id) => window.api.mods.logs(id), id)).some(
          (row) => row.text === "WRITE_WAIT"
        ),
      "write hook awaiting revocation"
    )
    await page.evaluate(({ id, pluginId }) => window.api.mods.revokeFunction(id, pluginId), {
      id,
      pluginId: mod.pluginId
    })
    await until(
      async () => (await jobs()).every((job) => job.state !== "queued" && job.state !== "running"),
      "revoked write command settles"
    )
    assert(!existsSync(join(project, "delayed.md")))
    pass("revocation before native execution cancels the delayed SDK write without late success")
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    const prior = await page.getByText("MODEL_TOOL_HOOK_OK", { exact: true }).count()
    const modelBefore = requests.length
    await send("[mods-tool-rewrite]")
    await until(
      async () =>
        (await page.getByText("MODEL_TOOL_HOOK_OK", { exact: true }).count()) > prior &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "original read with Mods off"
    )
    assert(JSON.stringify(requests.slice(modelBefore)).includes("ORIGINAL_WRITE_CONTROL_READ"))
    assert(!existsSync(join(project, "automatic.md")))
    await page.screenshot({ path: join(artifacts, "file-write-off.png") })
    pass("Mods off keeps the original model/native file read operational without SDK hook work")
  } finally {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (
        globalThis as unknown as { writeOriginalDialog: typeof dialog.showMessageBox }
      ).writeOriginalDialog
    })
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
