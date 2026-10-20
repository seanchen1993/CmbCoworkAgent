import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { expect, it } from "vitest"

it("installs skipped JavaScript foundations on Linux before the read-only build gate", () => {
  const workflow = parse(readFileSync(".github/workflows/build-electron.yml", "utf8")) as {
    jobs: { build: { steps: Array<Record<string, unknown>> } }
  }
  const steps = workflow.jobs.build.steps
  const index = (name: string) => steps.findIndex((step) => step.name === name)
  const install = index("Install native JavaScript foundations (Linux)")
  const verify = index("Verify native JavaScript foundations")
  expect(install).toBeGreaterThan(index("Install dependencies (Linux)"))
  expect(verify).toBeGreaterThan(install)
  expect(verify).toBeLessThan(index("Build"))
  expect(steps[install].if).toBe("runner.os == 'Linux'")
  expect(steps[install].run).toBe("node scripts/apply-langchain-native-foundations.mjs")
  expect(steps[verify].if).toBeUndefined()
  expect(steps[verify].run).toBe("node scripts/apply-langchain-native-foundations.mjs --check")
  for (const step of [steps[install], steps[verify]]) {
    expect(step["continue-on-error"]).toBeUndefined()
  }
  expect(steps[index("Install dependencies (Linux)")].run).toBe(
    "npm ci --ignore-scripts --include=optional"
  )
  expect(steps[index("Download node-pty binary from manylinux_2_28 job")].if).toBe(
    "runner.os == 'Linux'"
  )
  expect(String(steps[index("Package (Linux x64)")].run)).toContain("--config.npmRebuild=false")
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: { prebuild: string }
  }
  expect(pkg.scripts.prebuild).toMatch(
    /^node scripts\/apply-langchain-native-foundations\.mjs --check && /
  )
})

it("requires Windows packaged validation before upload/release and keeps diagnostic uploads bounded", () => {
  const workflow = parse(readFileSync(".github/workflows/build-electron.yml", "utf8")) as {
    jobs: { build: { steps: Array<Record<string, unknown>> } }
  }
  const steps = workflow.jobs.build.steps
  const index = (name: string) => steps.findIndex((step) => step.name === name)
  const validation = index("Validate Mods in Windows package")
  const cli = index("Prepare host CLI for Windows package validation")
  expect(cli).toBeGreaterThan(index("Package (Other platforms)"))
  expect(cli).toBeLessThan(validation)
  expect(steps[cli].if).toBe("matrix.platform == 'win'")
  expect(steps[cli]["continue-on-error"]).toBeUndefined()
  expect(String(steps[cli].run)).toContain(
    'npm install --global --prefix "$taskCliPrefix" @anthropic-ai/claude-code@2.1.295'
  )
  expect(String(steps[cli].run)).toContain("$env:GITHUB_PATH")
  expect(String(steps[cli].run)).toContain("if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }")
  expect(validation).toBeGreaterThan(index("Package (Other platforms)"))
  expect(validation).toBeLessThan(index("Upload installer"))
  expect(validation).toBeLessThan(index("Upload to GitHub Release"))
  const gate = steps[validation]
  expect(gate.if).toBe("matrix.platform == 'win'")
  expect(gate["continue-on-error"]).toBeUndefined()
  expect(gate.run).toBe(
    'node --import tsx scripts/run-mods-packaged-e2e.ts "dist/win-unpacked" "output/mods-v2-validation/actions-packaged"'
  )
  for (const name of ["Upload installer", "Upload unpacked (Windows)", "Upload to GitHub Release"])
    expect(String(steps[index(name)].if ?? "")).not.toMatch(/always\(|failure\(/)
  const diagnostics = steps[index("Upload Mods package validation evidence")]
  expect(diagnostics.if).toBe("always() && matrix.platform == 'win'")
  expect(
    String((diagnostics.with as Record<string, unknown>).path)
      .trim()
      .split(/\r?\n/)
  ).toEqual([
    "output/mods-v2-validation/actions-packaged/packaged-validation.json",
    "output/mods-v2-validation/actions-packaged/result.json",
    "output/mods-v2-validation/actions-packaged/packaged-runtime-evidence.json",
    "output/mods-v2-validation/actions-packaged/*.png"
  ])
})
