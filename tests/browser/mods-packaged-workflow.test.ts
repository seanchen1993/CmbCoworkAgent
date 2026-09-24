import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { expect, it } from "vitest"

it("requires Windows packaged validation before upload/release and keeps diagnostic uploads bounded", () => {
  const workflow = parse(readFileSync(".github/workflows/build-electron.yml", "utf8")) as {
    jobs: { build: { steps: Array<Record<string, unknown>> } }
  }
  const steps = workflow.jobs.build.steps
  const index = (name: string) => steps.findIndex((step) => step.name === name)
  const validation = index("Validate Mods in Windows package")
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
    "output/mods-v2-validation/actions-packaged/*.png"
  ])
})
