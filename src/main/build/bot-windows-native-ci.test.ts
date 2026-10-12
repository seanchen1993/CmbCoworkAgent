import { expect, it } from "vitest"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parse } from "yaml"

type Step = {
  name?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
}
async function workflow(path: string) {
  return parse(await readFile(resolve(path), "utf8"))
}
const action = "./.github/actions/build-bot-windows-native"
it("Windows CI builds the shared sealed native inputs before compiling and prepares the real runner before command tests", async () => {
  const ci = await workflow(".github/workflows/ci.yml")
  const steps: Step[] = ci.jobs.build.steps
  const native = steps.findIndex((step) => step.uses === action)
  const build = steps.findIndex((step) => step.run === "npm run build")
  const initialize = steps.findIndex(
    (step) => step.run === "node --import tsx tests/prepare-bot-windows-native.mts"
  )
  const source = steps.findIndex((step) =>
    step.run?.includes("src/main/bots/shell-process.test.ts")
  )
  const compiled = steps.findIndex((step) => step.run === "node tests/run-bot-shell-native.mjs")
  expect(native).toBeGreaterThanOrEqual(0)
  expect(steps[native].if).toBe("runner.os == 'Windows'")
  expect(build).toBeGreaterThan(native)
  expect(initialize).toBeGreaterThan(build)
  expect(source).toBeGreaterThan(initialize)
  expect(compiled).toBeGreaterThan(source)
  expect(steps[source].run).toContain("--maxWorkers=1 --minWorkers=1")
  expect(steps[source].run).toContain("src/main/bots/windows-native-kernel.test.ts")
})
it("release and CI use one source-pinned native build without converting build success into kernel acceptance", async () => {
  const release = await workflow(".github/workflows/build-electron.yml")
  const matches = Object.values(release.jobs)
    .flatMap((job: unknown) => (job as { steps?: Step[] }).steps ?? [])
    .filter((step) => step.uses === action)
  expect(matches).toHaveLength(1)
  expect(matches[0].if).toBe("runner.os == 'Windows'")
  const shared = await workflow(".github/actions/build-bot-windows-native/action.yml")
  expect(shared.runs.using).toBe("composite")
  const steps: Step[] = shared.runs.steps
  expect(steps.find((step) => step.name === "Checkout fixed native source")).toMatchObject({
    uses: "actions/checkout@v4",
    with: {
      repository: "openai/codex",
      ref: "954fa9057bf3a4521ea34dbd010ff291d5b39763",
      "persist-credentials": false
    }
  })
  expect(steps.find((step) => step.name === "Setup fixed Rust toolchain")).toMatchObject({
    with: { toolchain: "1.95.0" }
  })
  const build = steps.find((step) => step.name === "Build and seal native release inputs")!.run!
  expect(build).toContain("buildNativeSandboxPackage")
  expect(build).toContain("prepareBotNativeDistribution(values)")
  expect(build).toContain("prepared.package.assertCurrent()")
  for (const key of [
    "CMB_BUILD_BOT_NATIVE_DIRECTORY",
    "CMB_BUILD_BOT_NATIVE_MANIFEST_SHA256",
    "CMB_BUILD_BOT_NATIVE_TARGET"
  ])
    expect(build).toContain(key)
  expect(build).toContain("kernelAcceptance: 'not-tested'")
  const input = steps.find(
    (step) => step.name === "Verify fixed source and V8 release inputs"
  )!.run!
  expect(input).toContain("V8 release input checksum mismatch")
  expect(input).toContain("source-pinned checksum manifest")
})
it("compiled Windows gate requires five actual kernel assertions as well as every original Shell case", async () => {
  const gate = await readFile(resolve("tests/run-bot-shell-native.mjs"), "utf8")
  expect(gate).toContain('"src/main/bots/windows-native-kernel.test.ts"')
  expect(gate).toContain('windows ? require("electron") : process.execPath')
  expect(gate).toContain('ELECTRON_RUN_AS_NODE: "1"')
  expect(gate).toContain("kernel?.assertionResults.length === 5")
  expect(gate).toContain('value.status === "passed"')
  expect(gate).toContain("windows ? 22 : 18")
  expect(gate).toContain("Failed Shell gate report retained")
})
