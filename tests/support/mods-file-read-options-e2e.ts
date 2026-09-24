import assert from "node:assert/strict"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyFileReadOptions(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "file-read-options")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "note.txt"), "ACTUAL_READ_TEXT 中文")
  writeFileSync(join(project, "claw-notes"), "ORIGINAL_READ_OPTIONS_CONTROL")
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "File read options",
      workspacePath: project,
      agentMode: "normal"
    })
    const id =
      (thread as unknown as { thread_id: string }).thread_id ??
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
    Buffer.from(JSON.stringify({ name: "file-read-options", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on){
      const observed=[];
      on("session.start",async($,e,next)=>{await $.command.register({name:"read-options",description:"Read options",immediate:true});return next(e)});
      on("fs.read",($,e,next)=>{
        observed.push(e);
        if(e.path.endsWith("rewrite"))return next({...e,path:"note.txt",as:"bytes"});
        if(e.path.endsWith("legacy"))return next({path:"note.txt"});
        return next(e)
      });
      on("command.run",{command:"read-options"},async $=>{
        const call=async fn=>{try{return {value:await fn()}}catch(error){return {error:error.message}}};
        const values={
          default:await call(()=>$.fs.read("note.txt")),
          optional:await call(()=>$.fs.read("note.txt",undefined)),
          text:await call(()=>$.fs.read("note.txt",{as:"text"})),
          bytes:await call(()=>$.fs.read("note.txt",{as:"bytes"})),
          invalid:await call(()=>$.fs.read("note.txt",{as:"binary"})),
          unknown:await call(()=>$.fs.read("note.txt",{as:"text",unknown:true})),
          rewritten:await call(()=>$.fs.read("rewrite")),
          legacy:await call(()=>$.fs.read("legacy",{as:"text"}))
        };
        return {text:JSON.stringify({values,observed})}
      })
    }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "file-read-options.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
    (row) => row.name === "file-read-options"
  )!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("File read options", { exact: true }).first().click()
  const before = requests.length
  const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), id)).find(
    (row) => row.command === "read-options"
  )!
  assert(descriptor)
  const job = await page.evaluate(
    ({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "" }),
    { id, descriptor }
  )
  const jobs = () => page.evaluate((id) => window.api.mods.jobs(id), id)
  await until(
    async () =>
      (await jobs()).some((row) => row.id === job.id && !["running", "queued"].includes(row.state)),
    "file mode probe settles through the real session"
  )
  const result = (await jobs()).find((row) => row.id === job.id)!
  assert.equal(result.state, "succeeded", JSON.stringify(result))
  const evidence = JSON.parse(result.result!.text)
  writeFileSync(join(artifacts, "file-read-options.json"), JSON.stringify(evidence, null, 2))
  assert.deepEqual(evidence.values, {
    default: { value: "ACTUAL_READ_TEXT 中文" },
    optional: { value: "ACTUAL_READ_TEXT 中文" },
    text: { value: "ACTUAL_READ_TEXT 中文" },
    bytes: { error: "MODS_FS_BYTES_UNSUPPORTED" },
    invalid: { error: "MODS_FS_OPTIONS" },
    unknown: { error: "MODS_FS_OPTIONS" },
    rewritten: { error: "MODS_FS_BYTES_UNSUPPORTED" },
    legacy: { value: "ACTUAL_READ_TEXT 中文" }
  })
  const canonicalProject = realpathSync(project)
  const scope = process.platform === "win32" ? canonicalProject.toLowerCase() : canonicalProject
  assert.deepEqual(
    evidence.observed,
    ["note.txt", "note.txt", "note.txt", "rewrite", "legacy"].map((path) => ({
      path: join(scope, path),
      as: "text"
    }))
  )
  assert.equal(requests.length, before)
  pass(
    "actual text read mode reaches hooks while byte, malformed and rewritten modes cannot silently return text"
  )
  await page.screenshot({ path: join(artifacts, "file-read-options.png") })
  try {
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    assert.deepEqual(await page.evaluate((id) => window.api.mods.commands(id), id), [])
    const composer = page.locator("textarea.composer-textarea")
    await composer.fill("[mods-tool-rewrite]")
    await page.locator("form").filter({ has: composer }).locator('button[type="submit"]').click()
    await until(
      async () =>
        (await page.getByText("MODEL_TOOL_HOOK_OK", { exact: true }).count()) > 0 &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "original native file read with Mods off"
    )
    assert(JSON.stringify(requests.slice(before)).includes("ORIGINAL_READ_OPTIONS_CONTROL"))
    await page.screenshot({ path: join(artifacts, "file-read-options-off.png") })
    pass("Mods off retains the original model and native file read without the file SDK hook")
  } finally {
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
