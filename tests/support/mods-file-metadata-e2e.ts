import assert from "node:assert/strict"
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyFileMetadata(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "file-metadata-project")
  mkdirSync(join(project, "target"), { recursive: true })
  writeFileSync(join(project, "target", "note.txt"), "hello")
  writeFileSync(join(project, "claw-notes"), "ORIGINAL_METADATA_READ")
  symlinkSync(
    join(project, "target"),
    join(project, "alias"),
    process.platform === "win32" ? "junction" : "dir"
  )
  const outside = join(workspace, "file-metadata-outside")
  mkdirSync(outside)
  symlinkSync(outside, join(project, "outside"), process.platform === "win32" ? "junction" : "dir")
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "File metadata E2E",
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
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name: "file-metadata", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"metadata-probe",description:"Real file metadata"});return next(e)});
    on("fs.stat",async($,e,next)=>{
      if(e.path.endsWith("rewritten")) return next({...e,path:"alias/note.txt"});
      if(e.path.endsWith("delayed")) {
        const result=await next({...e,path:"alias"});
        $.ui.log("METADATA_WAIT");await $.clock.sleep(1000);return result
      }
      return next(e)
    });
    on("command.run",{command:"metadata-probe"},async($,e)=>{
      if(e.args==="outside"||e.args==="delayed") {
        try { return {text:"UNEXPECTED_METADATA:"+JSON.stringify(await $.fs.stat(e.args,{resolve:true}))} }
        catch(error) { return {text:"METADATA_ERROR:"+error.message} }
      }
      return {text:"METADATA:"+JSON.stringify({
        link:await $.fs.stat("alias",{resolve:true}), plain:await $.fs.stat("alias"),
        leaf:await $.fs.stat("rewritten",{resolve:true}), entries:await $.fs.list()
      })}
    });
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "file-metadata.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((row) => row.name === "file-metadata")!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("File metadata E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const send = async (text: string) => {
    await composer.fill(text)
    await page.locator("form").filter({ has: composer }).locator('button[type="submit"]').click()
  }
  const jobs = () => page.evaluate((id) => window.api.mods.jobs(id), threadId)
  const before = requests.length
  await send("/metadata-probe normal")
  await until(
    async () => (await jobs()).some((job) => job.result?.text.startsWith("METADATA:")),
    "real guest returns actual filesystem metadata"
  )
  const result = JSON.parse(
    (await jobs())
      .find((job) => job.result?.text.startsWith("METADATA:"))!
      .result!.text.slice("METADATA:".length)
  )
  writeFileSync(join(artifacts, "file-metadata.json"), JSON.stringify(result, null, 2))
  assert.equal(result.link.isLink, true)
  assert.equal(result.link.kind, "dir")
  assert.equal(result.link.realPath, realpathSync(join(project, "target")))
  assert.equal(result.plain.isLink, true)
  assert.equal(result.plain.realPath, undefined)
  assert.equal(result.leaf.isLink, false)
  assert.equal(result.leaf.realPath, realpathSync(join(project, "target", "note.txt")))
  assert.equal(result.leaf.size, 5)
  assert.deepEqual(
    result.entries.find((entry: { name: string }) => entry.name === "alias"),
    { name: "alias", kind: "other", size: 0, isLink: true }
  )
  assert.equal(requests.length, before)
  await page.screenshot({ path: join(artifacts, "file-metadata.png") })
  pass(
    "file SDK returns actual link and canonical metadata through guest, path rewrite and original project permissions without a model"
  )
  await send("/metadata-probe outside")
  await until(
    async () =>
      (await jobs()).some((job) =>
        /METADATA_ERROR:.*MODS_FS_(OUTSIDE_PROJECT|ACCESS_DENIED)/.test(job.result?.text ?? "")
      ),
    "outside junction remains denied"
  )
  pass("requesting canonical metadata cannot expand the original project boundary")
  await send("/metadata-probe delayed")
  await until(
    async () =>
      (await page.evaluate((id) => window.api.mods.logs(id), threadId)).some(
        (row) => row.text === "METADATA_WAIT"
      ),
    "metadata middleware is waiting"
  )
  await page.evaluate(({ id, pluginId }) => window.api.mods.revokeFunction(id, pluginId), {
    id: threadId,
    pluginId: mod.pluginId
  })
  await until(
    async () => (await jobs()).every((job) => job.state !== "running" && job.state !== "queued"),
    "revocation settles the in-flight metadata command"
  )
  assert(!(await jobs()).some((job) => job.result?.text.startsWith("UNEXPECTED_METADATA:")))
  pass("revocation rejects pending metadata before the old command can publish success")
  try {
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await send("[mods-tool-rewrite]")
    await until(
      async () =>
        (await page.getByText("MODEL_TOOL_HOOK_OK", { exact: true }).count()) > 0 &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "original native read remains available with Mods off"
    )
    assert(JSON.stringify(requests.slice(before)).includes("ORIGINAL_METADATA_READ"))
    await page.screenshot({ path: join(artifacts, "file-metadata-off.png") })
    pass("Mods off leaves the original agent and native file read working")
  } finally {
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
