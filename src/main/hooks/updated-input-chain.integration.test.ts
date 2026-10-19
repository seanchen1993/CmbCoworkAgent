import { afterEach, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import type { HookConfig, HookResult } from "./types"
import type { PluginHookMetadata, PluginMetadata } from "../types"

vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined
}))
vi.mock("../models/registry", () => ({
  getAvailableModelConfigOrDefault: vi.fn(),
  getModelConfigByRef: vi.fn()
}))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
vi.mock("../mods/manager", () => ({ getModsManager: () => undefined }))

import { runHooks } from "./runner"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"
import { mergeUpdatedInput } from "./updated-input"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it.each([
  [false, false],
  [true, false],
  [true, true]
])(
  "runs real ordered HTTP Hooks and final mandatory checks (conflict=%s, blocked=%s)",
  async (conflict, blockFinal) => {
    const root = await mkdtemp(join(tmpdir(), "hook-input-chain-"))
    cleanup.push(async () => {
      if (
        dirname(resolve(root)) !== resolve(tmpdir()) ||
        !basename(root).startsWith("hook-input-chain-")
      )
        throw Error("TEST_CLEANUP_BOUNDARY")
      await rm(root, { recursive: true, force: true })
    })
    const seen: Array<{ path: string; args: Record<string, unknown> }> = []
    const server = createServer(async (request, response) => {
      let body = ""
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      seen.push({ path: request.url!, args: input.tool_input })
      const result =
        request.url === "/first"
          ? {
              updatedInput: { destination: { path: "private-A", retained: true } },
              additionalContext: "KEEP_ORIGINAL_CONTEXT"
            }
          : request.url === "/second"
            ? {
                updatedInput: {
                  destination: { path: conflict ? "private-B" : "private-A" },
                  extra: "safe"
                },
                additionalContext: "SECOND_CONTEXT"
              }
            : input.tool_input.destination.path ===
                (conflict && !blockFinal ? "private-B" : "private-A")
              ? {}
              : { decision: "block", reason: "final destination rejected" }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result))
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    cleanup.push(
      () =>
        new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done()))
        )
    )
    const address = server.address()
    if (!address || typeof address === "string") throw Error("Missing HTTP fixture address")
    const hook = (id: string, path: string): HookConfig => ({
      id,
      event: "PreToolUse",
      type: "http",
      matcher: "write_file",
      url: `http://127.0.0.1:${address.port}/${path}`,
      timeout: 5000,
      enabled: true,
      createdAt: "",
      updatedAt: ""
    })
    const gate: PluginHookMetadata = {
      ...hook("plugin:business/gate", "gate"),
      pluginId: "business",
      pluginName: "business",
      pluginEnabled: true,
      hookPath: "hooks/hooks.json",
      pluginRoot: root,
      hookSourceType: "plugin",
      hookSourceRoot: root
    }
    const recorded: Array<{ id: string; result: HookResult }> = []
    const original = { destination: { path: "original" } }
    const result = await withRuntimePluginSource(
      issueRuntimePluginSourceToken({
        plugin: { id: "business", name: "business", path: root, enabled: true } as PluginMetadata,
        mode: "legacy",
        workspace: root,
        threadId: "thread",
        incarnationKey: "same",
        projectId: "project",
        operationId: "operation",
        packageDigest: "a".repeat(64),
        stageId: "review",
        requiredHooks: ["gate"]
      }),
      () =>
        runHooks(
          [hook("first", "first"), gate, hook("second", "second")],
          "PreToolUse",
          {
            workspacePath: root,
            sessionId: "thread",
            toolName: "write_file",
            toolArgs: original
          },
          (_event, hook, result) => recorded.push({ id: hook.id, result })
        )
    )
    expect(seen.map((row) => row.path)).toEqual(["/first", "/second", "/gate"])
    expect(seen[0].args).toEqual(original)
    expect(seen[1].args).toEqual(original) // Preserve the existing ordinary Hook input contract.
    expect(seen[2].args).toEqual({
      destination: { path: conflict ? "private-B" : "private-A", retained: true },
      extra: "safe"
    })
    expect(result?.blocked).toBe(blockFinal)
    expect(result?.additionalContext).toContain("KEEP_ORIGINAL_CONTEXT")
    expect(result?.additionalContext).toContain("SECOND_CONTEXT")
    if (conflict) {
      expect(result?.updatedInputMerge?.conflicts).toEqual([
        {
          field: "/destination/path",
          previous: { hookId: "first", order: 1 },
          current: { hookId: "second", order: 2 },
          resolution: "later-hook-wins"
        }
      ])
      const diagnostic = recorded.find((row) => row.id === "second")!.result
      expect(diagnostic.systemMessage).toContain("first → 2. second")
      expect(diagnostic.systemMessage).not.toMatch(/private-A|private-B|http:\/\//)
      if (blockFinal) expect(result?.reason).toContain("final destination rejected")
      else expect(mergeUpdatedInput(original, result?.updatedInput)).toEqual(seen[2].args)
    } else {
      expect(result?.updatedInputMerge?.conflicts).toEqual([])
      expect(mergeUpdatedInput(original, result?.updatedInput)).toEqual(seen[2].args)
      expect(recorded.find((row) => row.id === "second")!.result.systemMessage).toBeUndefined()
    }
  }
)
