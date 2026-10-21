import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import {
  wrapProjectRuntimeManifest,
  CONTEXT_HANDOFF_PROTOCOL
} from "../../../shared/project-runtime"
import { registerProjectRecoveryContextResolver } from "./recovery-context"
import { StageRecoveryHookJournal } from "../../hooks/stage-recovery-journal"
import type { HostSkillExecutionContext } from "./host-service"
import { runtimeDigest } from "./safe-files"
import type { HookConfig } from "../../hooks/types"

const state = vi.hoisted(() => ({ service: undefined as unknown }))
vi.mock("../../mods/devtools/project-stage-debug", () => ({
  getProjectStageDebugSessions: () => state.service
}))
import { executeStageRecoveryContextProvider } from "./stage-recovery-context-provider"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture(script: string) {
  const root = mkdtempSync(join(tmpdir(), "recovery-native-provider-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, "source"),
    workspace = join(root, "branch"),
    original = join(root, "original")
  const knowledge = join(root, "private-knowledge"),
    data = join(root, "private-context")
  for (const directory of [source, workspace, original, knowledge, data]) mkdirSync(directory)
  writeFileSync(join(original, "original.txt"), "ORIGINAL")
  writeFileSync(join(knowledge, "rules.md"), "NATIVE_FROZEN_KNOWLEDGE")
  writeFileSync(join(source, "provider.py"), script)
  const manifest = hostProjectFixture(workspace).manifest
  writeFileSync(
    join(source, "plugin.json"),
    JSON.stringify(
      manifest.plugin.id === "docs" ? { name: "docs", version: "1.0.0" } : manifest.plugin
    )
  )
  writeFileSync(
    join(source, "devclaw.project-runtime.json"),
    JSON.stringify(
      wrapProjectRuntimeManifest(manifest, {
        apiVersion: "devclaw.extension-contract/v1",
        requires: [CONTEXT_HANDOFF_PROTOCOL],
        context: {
          sourceAccess: "read-only",
          mutableData: "host",
          configuration: "host-resolved",
          knowledge: { required: true },
          provider: { entry: "provider.py", operations: ["session-context"] }
        }
      })
    )
  )
  writeFileSync(
    join(source, "devclaw.stage-recovery.json"),
    JSON.stringify({
      apiVersion: "devclaw.stage-recovery/v1",
      hookExecution: "windows-sandbox",
      externalEffects: "network-requires-confirmation",
      contextProvider: {
        protocol: "devclaw.context-text/v1",
        args: ["--workspace", "${workspace}", "--stage", "${stageId}"]
      }
    })
  )
  const settings = new Map<string, string>()
  const journal = new StageRecoveryHookJournal({
    getSetting: (key, fallback = "") => settings.get(key) ?? fallback,
    compareAndSetSetting: (key, before, next) => {
      if (settings.get(key) !== before) return false
      settings.set(key, next)
      return true
    }
  })
  const stageDebug = {
    workspace,
    baselineId: randomUUID(),
    commandHooks: {
      networkAccess: "explicitly-approved" as const,
      readOnlyRoots: [source, original, knowledge]
    }
  }
  state.service = {
    contextProviderExecution: async () => ({
      commandPolicy: stageDebug.commandHooks,
      bound: {
        directory: data,
        knowledgeRoot: knowledge,
        configuration: {
          audience: "native reviewers",
          selected: ["warehouse", "api"],
          enabled: false
        },
        assertCurrent: () => {
          if (readFileSync(join(original, "original.txt"), "utf8") !== "ORIGINAL")
            throw Error("ORIGINAL_CHANGED")
        }
      },
      guard: () => {},
      begin: (hook: HookConfig) =>
        journal.begin(
          {
            projectId: "branch",
            operationId: "operation",
            threadId: "native-thread",
            baselineId: stageDebug.baselineId,
            packageDigest: "a".repeat(64),
            stageId: "review",
            policyDigest: "b".repeat(64),
            hookDigest: runtimeDigest(JSON.stringify(hook))
          },
          () => {}
        )
    })
  }
  cleanup.push(
    registerProjectRecoveryContextResolver((scope) =>
      scope === workspace
        ? {
            directory: data,
            knowledgeRoot: knowledge,
            assertCurrent: () => {
              if (readFileSync(join(original, "original.txt"), "utf8") !== "ORIGINAL")
                throw Error("ORIGINAL_CHANGED")
            }
          }
        : undefined
    )
  )
  const controller = new AbortController()
  const context = {
    project: {
      ...hostProjectFixture(workspace),
      projectId: "branch",
      pluginDigest: "a".repeat(64)
    },
    operation: { operationId: "operation", stageId: "review" },
    goal: "Real provider knowledge",
    stageDebug,
    snapshotRoot: source,
    signal: controller.signal
  } as unknown as HostSkillExecutionContext
  return { root, source, workspace, original, knowledge, data, journal, context, controller }
}

it.runIf(process.platform === "win32")(
  "executes the retained context provider with real stdin, frozen knowledge and OS-protected upstream",
  async () => {
    const f = fixture(
      "import json, os, pathlib, sys\n" +
        "data=json.load(sys.stdin)\nw=pathlib.Path(data['workspace'])\n" +
        "assert data['configuration']=={'audience':'native reviewers','selected':['warehouse','api'],'enabled':False}\n" +
        "p=pathlib.Path(os.environ['DEVCLAW_KNOWLEDGE_ROOT'])/'rules.md'\n" +
        "try:\n p.write_text('unsafe')\n raise RuntimeError('knowledge was writable')\nexcept PermissionError: pass\n" +
        "original=w.parent/'original'/'original.txt'\n" +
        "try:\n original.write_text('unsafe')\n raise RuntimeError('original was writable')\nexcept PermissionError: pass\n" +
        "pathlib.Path(os.environ['DEVCLAW_PLUGIN_DATA_ROOT'],'per-run-cache.txt').write_text('scratch')\n" +
        "sys.stdout.write(p.read_text()+' '+data['stageId']+' '+str('--workspace' in sys.argv))\n"
    )
    await expect(
      executeStageRecoveryContextProvider(f.context, "native-thread", () => {})
    ).resolves.toBe("NATIVE_FROZEN_KNOWLEDGE review True")
    expect(readFileSync(join(f.original, "original.txt"), "utf8")).toBe("ORIGINAL")
    expect(readFileSync(join(f.knowledge, "rules.md"), "utf8")).toBe("NATIVE_FROZEN_KNOWLEDGE")
    expect(existsSync(join(f.data, "per-run-cache.txt"))).toBe(false)
    expect(f.journal.list("branch")).toMatchObject([{ phase: "settled", exitCode: 0 }])
  },
  20000
)

it.runIf(process.platform === "win32")(
  "cancels a real provider and keeps its effects unknown instead of publishing context",
  async () => {
    const f = fixture(
      "import json, pathlib, sys, time\n" +
        "w=pathlib.Path(json.load(sys.stdin)['workspace'])\n(w/'started.txt').write_text('actual')\n" +
        "time.sleep(30)\n(w/'late.txt').write_text('unsafe')\nprint('must not publish')\n"
    )
    const execution = executeStageRecoveryContextProvider(f.context, "native-thread", () => {})
    const deadline = Date.now() + 10000
    try {
      while (!existsSync(join(f.workspace, "started.txt")) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25))
      expect(existsSync(join(f.workspace, "started.txt"))).toBe(true)
    } finally {
      f.controller.abort()
      await execution.catch(() => {})
    }
    expect(f.journal.list("branch")).toMatchObject([{ phase: "unknown" }])
    expect(existsSync(join(f.workspace, "late.txt"))).toBe(false)
  },
  20000
)
