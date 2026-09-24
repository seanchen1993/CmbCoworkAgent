import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises"
import { join, resolve, relative, isAbsolute } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { afterEach, expect, it, vi } from "vitest"
import { runPackagedModsValidation } from "../../scripts/run-mods-packaged-e2e"

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    const child = relative(resolve(tmpdir()), root)
    if (!child || child.startsWith("..") || isAbsolute(child)) throw Error("Invalid fixture root")
    await rm(root, { recursive: true, force: true })
  }
})

/** Tests runner plumbing with real Node children, not Electron/package/business acceptance. */
async function fixture(script = "") {
  const root = await mkdtemp(join(tmpdir(), "mods-package-runner-"))
  roots.push(root)
  const packageDirectory = join(root, "dist/win-unpacked")
  const outputDirectory = join(root, "output/mods-v2-validation/run")
  await mkdir(join(packageDirectory, "resources"), { recursive: true })
  await writeFile(join(packageDirectory, "CMBDevClaw.exe"), "fixture executable metadata")
  await writeFile(join(packageDirectory, "resources/app.asar"), "fixture ASAR metadata")
  await mkdir(join(root, "node_modules/tsx/dist"), { recursive: true })
  await mkdir(join(root, "tests"))
  await writeFile(join(root, "tests/mods-e2e.spec.ts"), "fixture entry; not executed by fake tsx")
  await writeFile(
    join(root, "node_modules/tsx/dist/cli.mjs"),
    `
    import {writeFileSync} from "node:fs";
    import {join} from "node:path";
    writeFileSync("child-started.json",JSON.stringify({argv:process.argv.slice(2),env:{
      packaged:process.env.CMB_MODS_PACKAGED_DIR,artifacts:process.env.CMB_MODS_E2E_ARTIFACTS,
      focus:process.env.CMB_MODS_E2E_FOCUS,app:process.env.CMB_MODS_E2E_APP_DIR,
      bridge:process.env.CMB_MODS_E2E
    }}));
    ${script}
  `
  )
  return { root, packageDirectory, outputDirectory }
}

const receipt = `writeFileSync(join(process.env.CMB_MODS_E2E_ARTIFACTS,"result.json"),JSON.stringify({
  checks:["production ASAR starts without a test entry and contains the isolated runtime",
    ...Array.from({length:7},(_,i)=>"fixture check "+i),
    "packaged preload and React settings retain project grants after reload"],timings:{}
}));`

it("fails a missing package without launching or rebuilding it", async () => {
  const f = await fixture()
  await rm(join(f.packageDirectory, "resources/app.asar"))
  await expect(runPackagedModsValidation(f)).rejects.toThrow("MODS_PACKAGED_FILE_MISSING")
  await expect(stat(join(f.root, "child-started.json"))).rejects.toThrow()
  await expect(stat(join(f.root, "out"))).rejects.toThrow()
})

it("runs only the packaged branch and retains binary fingerprints and a completed receipt", async () => {
  vi.stubEnv("CMB_MODS_E2E_FOCUS", "desktop-latency")
  vi.stubEnv("CMB_MODS_E2E_APP_DIR", "unpacked-source-substitute")
  vi.stubEnv("CMB_MODS_E2E", "1")
  const f = await fixture(receipt)
  expect(await runPackagedModsValidation(f)).toBe(0)
  const child = JSON.parse(await readFile(join(f.root, "child-started.json"), "utf8"))
  expect(child.argv).toEqual([join(f.root, "tests/mods-e2e.spec.ts")])
  expect(child.env).toEqual({
    packaged: f.packageDirectory,
    artifacts: f.outputDirectory,
    bridge: "0"
  })
  const report = JSON.parse(
    await readFile(join(f.outputDirectory, "packaged-validation.json"), "utf8")
  )
  expect(report.passed).toBe(true)
  expect(report.fingerprints.asar).toMatch(/^[a-f0-9]{64}$/)
  expect(report.fingerprints.executable).toMatch(/^[a-f0-9]{64}$/)
  expect(report.checks).toBe(9)
  await expect(stat(join(f.root, "out"))).rejects.toThrow()
})

it("fails a timed-out child within the runner deadline", async () => {
  const f = await fixture("setInterval(()=>{},1000);")
  expect(await runPackagedModsValidation({ ...f, timeoutMs: 500 })).toBe(1)
  const report = JSON.parse(
    await readFile(join(f.outputDirectory, "packaged-validation.json"), "utf8")
  )
  expect(report.passed).toBe(false)
  expect(report.childError).toBe("ETIMEDOUT")
})

it("preserves child failure even when a success-shaped result was written", async () => {
  const f = await fixture(receipt + "process.exitCode=23;")
  expect(await runPackagedModsValidation(f)).toBe(23)
  const report = JSON.parse(
    await readFile(join(f.outputDirectory, "packaged-validation.json"), "utf8")
  )
  expect(report.passed).toBe(false)
  expect(report.childExitCode).toBe(23)
})

it.each(["", 'writeFileSync(join(process.env.CMB_MODS_E2E_ARTIFACTS,"result.json"),"{}");'])(
  "rejects zero exit without a completed packaged receipt (%s)",
  async (script) => {
    const f = await fixture(script)
    await expect(runPackagedModsValidation(f)).rejects.toThrow("MODS_PACKAGED_RECEIPT_INVALID")
  }
)

it("rejects an ASAR changed during the child run", async () => {
  const f = await fixture(
    receipt +
      'writeFileSync(join(process.env.CMB_MODS_PACKAGED_DIR,"resources/app.asar"),"changed");'
  )
  await expect(runPackagedModsValidation(f)).rejects.toThrow("MODS_PACKAGED_CHANGED")
})

it("refuses existing evidence instead of reusing or deleting it", async () => {
  const f = await fixture(receipt)
  await mkdir(f.outputDirectory, { recursive: true })
  await writeFile(join(f.outputDirectory, "keep.txt"), "retained")
  await expect(runPackagedModsValidation(f)).rejects.toThrow("MODS_PACKAGE_OUTPUT_EXISTS")
  expect(await readFile(join(f.outputDirectory, "keep.txt"), "utf8")).toBe("retained")
  await expect(stat(join(f.root, "child-started.json"))).rejects.toThrow()
})

it("the actual CLI rejects missing arguments instead of silently succeeding", () => {
  const script = resolve("scripts/run-mods-packaged-e2e.ts")
  for (const entry of process.platform === "win32" ? [script, script.toLowerCase()] : [script]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", entry], {
      cwd: resolve("."),
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000
    })
    expect(child.status).toBe(1)
    expect(child.stderr).toContain("Usage: node --import tsx")
  }
})
