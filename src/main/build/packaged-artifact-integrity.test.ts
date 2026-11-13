import { mkdtemp, mkdir, writeFile, rm, cp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPackageWithOptions } from "@electron/asar"
import { parse as parseYaml } from "yaml"
import { afterEach, expect, it } from "vitest"
import { verifyPackagedArtifactIntegrity } from "./packaged-artifact-integrity"

const cleanups: string[] = []
const manifest = "out/resources/mods/example/.claude-plugin/plugin.json"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "packaged-artifact-"))
  cleanups.push(root)
  const source = join(root, "source")
  const original = join(root, "original")
  await mkdir(join(source, "out/resources/mods/example/.claude-plugin"), { recursive: true })
  await mkdir(join(original, "resources"), { recursive: true })
  await writeFile(join(source, "package.json"), '{"name":"fixture","version":"2.0.0"}')
  await writeFile(join(source, manifest), '{"name":"example","version":"1.0.0"}')
  await createPackageWithOptions(source, join(original, "resources/app.asar"), {
    dot: true,
    unpackDir: "out/resources/mods"
  })
  await writeFile(join(original, "CMBDevClaw.exe"), "fixture executable bytes")
  const downloaded = join(root, "downloaded")
  await cp(original, downloaded, { recursive: true })
  return { original, downloaded, hidden: join(downloaded, "resources/app.asar.unpacked", manifest) }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it("verifies hidden plugin manifests after an artifact round trip", async () => {
  const f = await fixture()
  const result = await verifyPackagedArtifactIntegrity(f.downloaded, f.original)
  expect(result).toMatchObject({
    passed: true,
    unpackedFiles: 1,
    verifiedFiles: 1,
    missing: [],
    invalid: []
  })
})

it("rejects the Actions hidden-file omission even when the ASAR and executable match", async () => {
  const f = await fixture()
  await rm(f.hidden)
  const result = await verifyPackagedArtifactIntegrity(f.downloaded, f.original)
  expect(result).toMatchObject({
    passed: false,
    verifiedFiles: 0,
    missing: [`resources/app.asar.unpacked/${manifest}`],
    invalid: []
  })
})

it("rejects a same-size changed unpacked manifest", async () => {
  const f = await fixture()
  const original = await readFile(f.hidden, "utf8")
  await writeFile(f.hidden, original.replace("example", "changed"))
  const result = await verifyPackagedArtifactIntegrity(f.downloaded, f.original)
  expect(result).toMatchObject({
    passed: false,
    missing: [],
    invalid: [`resources/app.asar.unpacked/${manifest}`]
  })
})

it("rejects a changed executable and archive independently of unpacked integrity", async () => {
  const f = await fixture()
  await writeFile(join(f.downloaded, "CMBDevClaw.exe"), "another executable")
  const archive = join(f.downloaded, "resources/app.asar")
  await writeFile(archive, Buffer.concat([await readFile(archive), Buffer.from("extra")]))
  const result = await verifyPackagedArtifactIntegrity(f.downloaded, f.original)
  expect(result.passed).toBe(false)
  expect(new Set(result.invalid)).toEqual(new Set(["resources/app.asar", "CMBDevClaw.exe"]))
})

it("rejects a missing package entry before reading the ASAR", async () => {
  const f = await fixture()
  await rm(join(f.downloaded, "CMBDevClaw.exe"))
  await expect(verifyPackagedArtifactIntegrity(f.downloaded, f.original)).rejects.toThrow(
    "PACKAGED_ARTIFACT_ENTRY_INVALID"
  )
})

it("rejects missing and same-size changed runtime resources outside ASAR", async () => {
  const f = await fixture()
  await mkdir(join(f.original, "locales"))
  await mkdir(join(f.downloaded, "locales"))
  await writeFile(join(f.original, "locales/en-US.pak"), "locale bytes")
  await writeFile(join(f.original, "icudtl.dat"), "original ICU")
  await writeFile(join(f.downloaded, "icudtl.dat"), "modified ICU")
  const result = await verifyPackagedArtifactIntegrity(f.downloaded, f.original)
  expect(result.passed).toBe(false)
  expect(result.missing).toEqual(["locales/en-US.pak"])
  expect(result.invalid).toEqual(["icudtl.dat"])
})

it("rejects an unexpected file added to the downloaded runtime", async () => {
  const f = await fixture()
  await writeFile(join(f.downloaded, "unexpected.js"), "extra runtime code")
  const result = await verifyPackagedArtifactIntegrity(f.downloaded, f.original)
  expect(result.passed).toBe(false)
  expect(result.invalid).toEqual(["unexpected:unexpected.js"])
})

it("keeps hidden files in the published Windows artifact and validates the download", async () => {
  const workflow = parseYaml(await readFile(".github/workflows/build-electron.yml", "utf8")) as {
    jobs: Record<
      string,
      {
        steps?: Array<{
          name?: string
          uses?: string
          run?: string
          with?: Record<string, unknown>
        }>
      }
    >
  }
  const steps = Object.values(workflow.jobs).find((job) =>
    job.steps?.some((step) => step.name === "Upload unpacked (Windows)")
  )!.steps!
  const upload = steps.findIndex((step) => step.name === "Upload unpacked (Windows)")
  expect(steps[upload].with).toMatchObject({
    path: "dist/win-unpacked/",
    "include-hidden-files": true,
    "if-no-files-found": "error"
  })
  const download = steps.findIndex(
    (step, index) =>
      index > upload &&
      step.uses === "actions/download-artifact@v4" &&
      step.with?.name === steps[upload].with?.name
  )
  expect(download).toBeGreaterThan(upload)
  expect(steps[download].with?.path).toBe("output/downloaded-win-unpacked")
  const integrity = steps.findIndex(
    (step, index) => index > download && step.run?.includes("scripts/verify-packaged-artifact.ts")
  )
  expect(integrity).toBeGreaterThan(download)
  expect(steps[integrity].run).toContain('"output/downloaded-win-unpacked" "dist/win-unpacked"')
  expect(
    steps
      .slice(integrity + 1)
      .some((step) =>
        step.run?.includes('scripts/run-mods-packaged-e2e.ts "output/downloaded-win-unpacked"')
      )
  ).toBe(true)
})
