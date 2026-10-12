import { expect, it } from "vitest"
import { build } from "esbuild"

it.each([
  "backup-entry",
  "backup-snapshot-entry",
  "browser-maintenance-entry",
  "workspace-maintenance-entry"
])(
  "bundles %s without models, browser automation, desktop services or an executor",
  async (entry) => {
    const result = await build({
      entryPoints: [`src/main/bots/${entry}.ts`],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      metafile: true,
      logLevel: "silent",
      external: ["electron"]
    })
    const dependencies = Object.keys(result.metafile!.inputs).map((name) =>
      name.replaceAll("\\", "/")
    )
    expect(dependencies).toContain("src/main/services/stable-file-handle.ts")
    expect(
      dependencies.filter((name) =>
        /src\/main\/(?:agent\/|models\/|browser\/|ipc\/|storage\.ts|bots\/(?:host\.ts|agent-runtime\.ts|computer-provider\.ts))/.test(
          name
        )
      )
    ).toEqual([])
    expect(
      Object.values(result.metafile!.outputs).flatMap((output) =>
        output.imports.map((item) => item.path)
      )
    ).not.toContain("electron")
  }
)

it("bundles the real Bot shell executor without desktop IPC, Electron, settings or Mods services", async () => {
  const result = await build({
    entryPoints: ["src/main/bots/shell-worker-entry.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    metafile: true,
    logLevel: "silent",
    external: ["electron", "original-fs", "node-pty"]
  })
  const dependencies = Object.keys(result.metafile!.inputs).map((name) =>
    name.replaceAll("\\", "/")
  )
  expect(dependencies).toContain("src/main/agent/local-sandbox-core.ts")
  expect(dependencies).not.toContain("src/main/agent/local-sandbox.ts")
  expect(dependencies.filter((name) => /src\/main\/(ipc\/|storage\.ts|mods\/)/.test(name))).toEqual(
    []
  )
  const imports = Object.values(result.metafile!.outputs).flatMap((output) =>
    output.imports.map((item) => item.path)
  )
  expect(imports).not.toContain("electron")
})

it("bundles the shared Cmb graph without loading desktop services", async () => {
  const result = await build({
    entryPoints: ["src/main/bots/agent-runtime.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    metafile: true,
    logLevel: "silent",
    external: ["electron", "original-fs", "node-pty"]
  })
  const dependencies = Object.keys(result.metafile!.inputs).map((name) =>
    name.replaceAll("\\", "/")
  )
  expect(dependencies).toContain("src/main/agent/deep-agent-core.ts")
  expect(dependencies).not.toContain("src/main/agent/runtime.ts")
  expect(
    dependencies.filter((name) =>
      /src\/main\/(ipc\/|storage\.ts|db\/|mods\/(?:desktop-process|manager|policy|runtime-client)\.ts|mods\/v2\/(?:manager|runtime-client|session-read-host|model-provider)\.ts)/.test(
        name
      )
    )
  ).toEqual([])
  expect(dependencies).toContain("src/main/mods/manager-core.ts")
  expect(dependencies).toContain("src/main/mods/v2/manager-core.ts")
  const imports = Object.values(result.metafile!.outputs).flatMap((output) =>
    output.imports.map((item) => item.path)
  )
  expect(imports).not.toContain("electron")
})

it("shares structured workflow output without importing the desktop subagent runtime or trace services", async () => {
  const result = await build({
    entryPoints: ["src/main/agent/workflow/structured-output.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    metafile: true,
    logLevel: "silent",
    external: ["electron"]
  })
  const dependencies = Object.keys(result.metafile!.inputs)
  expect(dependencies).toContain("src/main/agent/workflow/json-schema.ts")
  expect(
    dependencies.filter((name) =>
      /src\/main\/(ipc\/|storage\.ts|db\/|agent\/(runtime\.ts|trace\/|workflow\/subagent\.ts))/.test(
        name
      )
    )
  ).toEqual([])
  expect(
    Object.values(result.metafile!.outputs).flatMap((output) =>
      output.imports.map((item) => item.path)
    )
  ).not.toContain("electron")
})

it("keeps the macOS credential helper isolated from desktop and Bot execution services", async () => {
  const result = await build({
    entryPoints: ["src/main/bots/mac-secret-helper-entry.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    metafile: true,
    logLevel: "silent",
    external: ["electron"]
  })
  const inputs = Object.keys(result.metafile!.inputs).map((name) => name.replaceAll("\\", "/"))
  expect(inputs.sort()).toEqual([
    "src/main/bots/mac-secret-helper-entry.ts",
    "src/main/bots/mac-secret-helper.ts",
    "src/main/bots/mac-secret-owner-watch.ts",
    "src/main/bots/mac-secret-protocol.ts"
  ])
})
