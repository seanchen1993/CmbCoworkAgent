import { afterEach, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { readHarnessCatalogPage } from "./catalog-reader"
import { assertPackageExtensionCompatibility } from "../plugins/extension-contract"
import {
  EXTENSION_BOARD_API_VERSION,
  EXTENSION_CONTRACT_API_VERSION,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL
} from "../../shared/project-runtime"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it("the actual previous board reader rejects api2 while the new host requires a validated v2 contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "board-version-gate-"))
  roots.push(root)
  const pluginRoot = join(root, "plugin")
  mkdirSync(join(pluginRoot, "board_core"), { recursive: true })
  const board = (version: number) =>
    writeFileSync(
      join(pluginRoot, "board_core/board_config.json"),
      JSON.stringify({ apiVersion: version, inspectCommands: {} })
    )
  const projects = join(root, "projects.json"),
    plugins = join(root, "plugins.json")
  writeFileSync(projects, JSON.stringify({ version: 1, projects: [] }))
  writeFileSync(
    plugins,
    JSON.stringify([
      {
        id: "business",
        name: "business",
        version: "1.0.0",
        enabled: true,
        path: pluginRoot,
        skillCount: 1,
        mcpServerCount: 0,
        description: "",
        author: "",
        createdAt: "",
        updatedAt: ""
      }
    ])
  )
  // Exact previous implementation captured from d3edb4a10366a52ab6282783ab2bc22c000278e6.
  const historical = readFileSync(
    new URL("../../../tests/fixtures/legacy-board-catalog-reader-20261017.ts.txt", import.meta.url),
    "utf8"
  )
  const output = join(root, "legacy.cjs")
  await build({
    stdin: {
      contents: historical,
      loader: "ts",
      sourcefile: "legacy-reader.ts",
      resolveDir: fileURLToPath(new URL(".", import.meta.url))
    },
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22"
  })
  const legacy = createRequire(import.meta.url)(output) as {
    readHarnessCatalogPage: typeof readHarnessCatalogPage
  }
  const read = (reader = readHarnessCatalogPage) =>
    reader(projects, plugins, { registryLimit: 1 }).registry[0].boardCompatibility
  board(1)
  expect(read(legacy.readHarnessCatalogPage).compatible).toBe(true)
  expect(read().compatible).toBe(true)
  board(EXTENSION_BOARD_API_VERSION)
  expect(read(legacy.readHarnessCatalogPage)).toMatchObject({
    compatible: false,
    status: "app-too-old"
  })
  expect(read().compatible).toBe(false)
  expect(() => assertPackageExtensionCompatibility(pluginRoot)).toThrow(
    "EXTENSION_CONTRACT_REQUIRED"
  )
  const runtime = {
    apiVersion: "devclaw.project-runtime/v2",
    runtime: {
      apiVersion: "devclaw.project-runtime/v1",
      plugin: { id: "business", version: "1.0.0" },
      mode: "legacy",
      stateOwner: "plugin",
      stages: [],
      actions: [],
      artifacts: [],
      checks: [],
      environment: [],
      capabilities: {
        execution: true,
        conditionalTransition: false,
        idempotency: false,
        reconciliation: false,
        cancellation: true
      }
    },
    extensionContract: {
      apiVersion: EXTENSION_CONTRACT_API_VERSION,
      requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL]
    }
  }
  const path = join(pluginRoot, "devclaw.project-runtime.json")
  writeFileSync(path, JSON.stringify(runtime))
  expect(read()).toMatchObject({ compatible: true, appApiVersion: EXTENSION_BOARD_API_VERSION })
  expect(read(legacy.readHarnessCatalogPage).compatible).toBe(false)
  board(1)
  expect(read().compatible).toBe(false)
  expect(() => assertPackageExtensionCompatibility(pluginRoot)).toThrow(
    "EXTENSION_BOARD_VERSION_REQUIRED"
  )
})
