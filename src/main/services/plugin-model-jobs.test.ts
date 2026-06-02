import { mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BackgroundModelJobRequest } from "../../shared/plugin-model-jobs"

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock("../db", () => ({
  getAllThreads: () => []
}))
vi.mock("../storage", () => ({
  getPlugins: vi.fn(() => [])
}))
vi.mock("../plugins/manifest", async () => {
  const actual = await vi.importActual<typeof import("../plugins/manifest")>("../plugins/manifest")
  return {
    ...actual,
    readPluginManifest: vi.fn()
  }
})

import { getPlugins } from "../storage"
import { readPluginManifest } from "../plugins/manifest"
import { parseModelFilesForPluginModelJobTest } from "./plugin-model-jobs"
import { BackgroundJobValidationError, validateBackgroundJobRequest } from "./plugin-model-job-permissions"

const mockedGetPlugins = vi.mocked(getPlugins)
const mockedReadPluginManifest = vi.mocked(readPluginManifest)

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "plugin-model-jobs-"))
}

function registerPlugin(workspace: string): void {
  const pluginRoot = join(workspace, "plugin")
  mkdirSync(join(pluginRoot, "jobs"), { recursive: true })
  writeFileSync(
    join(pluginRoot, "plugin.json"),
    JSON.stringify({ id: "demo-plugin", name: "Demo", backgroundJobs: "jobs/jobs.json" }),
    "utf8"
  )
  writeFileSync(
    join(pluginRoot, "jobs", "jobs.json"),
    JSON.stringify({
      schemaVersion: 1,
      jobs: [
        {
          type: "review",
          modelAccess: true,
          readScopes: [{ name: "inputs", root: "inputs", patterns: ["**/*.md"] }],
          writeScopes: [{ name: "reports", root: "reports", patterns: ["**/*.md"], risk: "low" }]
        }
      ]
    }),
    "utf8"
  )
  mockedGetPlugins.mockReturnValue([
    {
      id: "demo-plugin",
      name: "Demo",
      version: "1.0.0",
      description: "demo plugin",
      author: "test",
      path: pluginRoot,
      enabled: true,
      skillCount: 0,
      mcpServerCount: 0,
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z"
    }
  ])
  mockedReadPluginManifest.mockReturnValue({
    manifest: { name: "Demo", backgroundJobs: "jobs/jobs.json" },
    path: join(pluginRoot, "plugin.json"),
    relPath: "plugin.json"
  })
}

function baseRequest(workspace: string): BackgroundModelJobRequest {
  return {
    schemaVersion: 1,
    jobId: "job-1",
    pluginId: "demo-plugin",
    type: "review",
    workspace,
    promptFile: "inputs/prompt.md",
    inputFiles: ["inputs/context.md"],
    outputs: [{ path: "reports/result.md", scope: "reports", mode: "overwrite" }]
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("plugin model job model output parsing", () => {
  it("parses JSON content that contains braces", () => {
    const files = parseModelFilesForPluginModelJobTest(
      JSON.stringify({
        files: [
          {
            path: "reports/result.md",
            content: "示例代码：function demo() { return { ok: true } }"
          }
        ]
      })
    )
    expect(files).toEqual([
      {
        path: "reports/result.md",
        content: "示例代码：function demo() { return { ok: true } }"
      }
    ])
  })

  it("accepts fenced JSON without brace-depth extraction", () => {
    const files = parseModelFilesForPluginModelJobTest(
      '```json\n{"files":[{"path":"reports/result.md","content":"{not json, just text}"}]}\n```'
    )
    expect(files[0]?.content).toBe("{not json, just text}")
  })
})

describe("plugin model job validation", () => {
  it("uses scope-relative patterns for outputs", () => {
    const workspace = makeWorkspace()
    registerPlugin(workspace)
    mkdirSync(join(workspace, "inputs"), { recursive: true })
    mkdirSync(join(workspace, "reports"), { recursive: true })
    writeFileSync(join(workspace, "inputs", "prompt.md"), "prompt", "utf8")
    writeFileSync(join(workspace, "inputs", "context.md"), "context", "utf8")

    const validated = validateBackgroundJobRequest(baseRequest(workspace))
    expect(validated.outputFiles[0]?.relativePath).toBe("reports/result.md")
  })

  it("rejects oversized input before enqueue", () => {
    const workspace = makeWorkspace()
    registerPlugin(workspace)
    mkdirSync(join(workspace, "inputs"), { recursive: true })
    mkdirSync(join(workspace, "reports"), { recursive: true })
    writeFileSync(join(workspace, "inputs", "prompt.md"), "prompt", "utf8")
    writeFileSync(join(workspace, "inputs", "context.md"), "x".repeat(1024 * 1024 + 1), "utf8")

    expect(() => validateBackgroundJobRequest(baseRequest(workspace))).toThrow(BackgroundJobValidationError)
    try {
      validateBackgroundJobRequest(baseRequest(workspace))
    } catch (error) {
      expect(error).toBeInstanceOf(BackgroundJobValidationError)
      expect((error as BackgroundJobValidationError).code).toBe("INPUT_TOO_LARGE")
    }
  })
})
