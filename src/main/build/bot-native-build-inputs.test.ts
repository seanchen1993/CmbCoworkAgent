import { expect, test } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, realpath, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const builder = pathToFileURL(resolve("scripts/bot-native-sandbox/build-native-package.mjs")).href
async function firstBuildDecision(
  overrides: Record<string, string>
): Promise<{ error: string; files: string[] }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-native-build-input-")))
  const environment = { ...process.env, ...overrides }
  for (const key of [
    "CODEX_SKIP_BWRAP_BUILD",
    "CODEX_BWRAP_SOURCE_DIR",
    "CARGO_TARGET_DIR",
    "CARGO_BUILD_TARGET"
  ])
    if (!Object.hasOwn(overrides, key)) delete environment[key]
  try {
    // Only the build-input decision is exercised. The matching-platform branch
    // is selected in this isolated Node process; no native compiler/kernel runs.
    const code = `
Object.defineProperty(process, "platform", { value: "linux" });
const { buildNativeSandboxPackage } = await import(${JSON.stringify(builder)});
try {
 await buildNativeSandboxPackage({
   sourceCheckout: ${JSON.stringify(join(root, "missing-source"))},
   outputDirectory: ${JSON.stringify(join(root, "new-output"))}
 });
 process.stdout.write(JSON.stringify({ error: "unexpected build admission" }));
} catch (error) {
 process.stdout.write(JSON.stringify({ error: error.message }));
}
`
    const result = await execute(process.execPath, ["--input-type=module", "-e", code], {
      env: environment,
      timeout: 10_000,
      maxBuffer: 4096
    })
    return { ...JSON.parse(result.stdout), files: await readdir(root) }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test.each([
  ["CODEX_SKIP_BWRAP_BUILD", "1"],
  ["CODEX_SKIP_BWRAP_BUILD", ""],
  ["CODEX_BWRAP_SOURCE_DIR", "/outside-the-archived-fixed-source"],
  ["CODEX_BWRAP_SOURCE_DIR", ""]
])(
  "fixed Linux source rejects %s presence (%j) before creating build output",
  async (key, value) => {
    const result = await firstBuildDecision({ [key]: value })
    expect(result.error).toBe(`Fixed Linux native build does not allow ${key}`)
    expect(result.files).toEqual([])
  }
)

test("valid Cargo/V8 compiler inputs retain the existing source-path validation", async () => {
  const result = await firstBuildDecision({
    RUSTY_V8_ARCHIVE: "/verified-matching-v8-archive",
    RUSTY_V8_SRC_BINDING_PATH: "/verified-matching-v8-bindings",
    CARGO_BUILD_JOBS: "2"
  })
  expect(result.error).toContain("ENOENT")
  expect(result.error).not.toContain("does not allow")
  expect(result.files).toEqual([])
})
