import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import ts from "typescript"
import { isSameWorkspacePath } from "../../shared/workspace-path"
import { readRuntimeScopedFile } from "./project-runtime/safe-files"
import * as limits from "./store-limits"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Execute the exact original reader and its actual private normalizers, without app startup. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "legacy-project-authority-"))
  roots.push(root)
  const workspace = join(root, "project")
  mkdirSync(workspace)
  const source = ts.createSourceFile(
    "service.ts",
    readFileSync(new URL("./service.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const names = [
    "isObject",
    "normalizeText",
    "normalizeProjectCreator",
    "normalizeProject",
    "normalizeProjectStore",
    "projectDirectoryName",
    "projectDirectoryPath",
    "isInsideDirectory",
    "assertHarnessProjectAdapterCurrent"
  ]
  const declarations = names.map((name) => {
    const node = source.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
    )
    if (!node) throw Error(`Missing actual production helper: ${name}`)
    return node.getText(source).replace(/^export /, "")
  })
  const read = vi.fn(readRuntimeScopedFile)
  const dependencies = {
    ...limits,
    readRuntimeScopedFile: read,
    isSameWorkspacePath,
    basename,
    isAbsolute,
    join,
    relative,
    resolve,
    getOpenworkDir: () => root,
    // Availability admission is orthogonal; the real bounded store/parser/path fences execute.
    assertHarnessConfigAvailable: () => undefined
  }
  const javascript = ts.transpileModule(declarations.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const assert = new Function(
    ...Object.keys(dependencies),
    javascript + "\nreturn assertHarnessProjectAdapterCurrent"
  )(...Object.values(dependencies)) as (
    projectId: string,
    workspace: string,
    installedId: string
  ) => void
  const project = {
    projectId: "original",
    name: "Original",
    workspacePath: root,
    projectDir: "project",
    "harness-adapter": { id: "installed-uuid", name: "Plugin", type: "plugin" }
  }
  const path = join(root, "harness-board-projects.json")
  const save = (projects: unknown[]) =>
    writeFileSync(path, JSON.stringify({ version: 1, projects }))
  save([project])
  return { root, workspace, assert, project, save, read, path }
}

it("reads the original durable project binding once per full fence and never reuses old project facts", () => {
  const f = fixture()
  expect(() => f.assert("original", f.workspace, "installed-uuid")).not.toThrow()
  expect(f.read).toHaveBeenCalledTimes(1)
  f.save([{ ...f.project, "harness-adapter": { ...f.project["harness-adapter"], id: "new-uuid" } }])
  expect(() => f.assert("original", f.workspace, "installed-uuid")).toThrow(
    "PROJECT_LEGACY_SCOPE_CHANGED"
  )
  expect(f.read).toHaveBeenCalledTimes(2)
  f.save([f.project])
  expect(() => f.assert("original", f.workspace, "installed-uuid")).not.toThrow()
  expect(f.read).toHaveBeenCalledTimes(3)
})

it("rejects removed, duplicated, relocated and over-budget original project bindings", () => {
  const f = fixture()
  for (const projects of [[], [f.project, f.project], [{ ...f.project, projectDir: "other" }]]) {
    f.save(projects)
    expect(() => f.assert("original", f.workspace, "installed-uuid")).toThrow(
      "PROJECT_LEGACY_SCOPE_CHANGED"
    )
  }
  f.save([{ ...f.project, projectDir: "../outside" }])
  expect(() => f.assert("original", f.workspace, "installed-uuid")).toThrow("outside workspace")
  writeFileSync(f.path, "x".repeat(limits.HARNESS_PROJECT_STORE_MAX_BYTES + 1))
  expect(() => f.assert("original", f.workspace, "installed-uuid")).toThrow("FILE_LIMIT")
})
