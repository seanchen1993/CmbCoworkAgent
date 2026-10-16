import { AsyncResource } from "node:async_hooks"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { ModsManager } from "../manager"
import { FunctionDevelopmentSessions, type DevelopmentActivation } from "./development-session"
import { withDevelopmentNativeAuthority } from "./development-native-authority"
import { withFunctionAgentExecution } from "./host-call"
import type { FunctionTurnComplete } from "../../../shared/mods/v2/turn"

const hooks = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("./agent-spawn-host", () => ({
  prepareFunctionAgentPlan: async (input: Record<string, unknown>, workspace: string) => ({
    prompt: input.prompt,
    description: input.description,
    type: "general-purpose",
    model: "custom:model",
    workspace,
    modelFingerprint: "snapshot"
  }),
  runFunctionAgentChild: (...args: unknown[]) => hooks.run(...args)
}))

it.each(["stop", "source", "narrowing"] as const)(
  "keeps an owned child alive after spawn returns until %s without renewing guest authority",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "development-agent-lifetime-"))
    const manager = new ModsManager(
      join(root, "control.sqlite"),
      () => [],
      async () => true,
      () => {}
    )
    manager.configure(root, true, false)
    const workspace = manager.workspaceKey(root)
    const instance = manager.createRuntimeAuthority({
      workspace,
      threadId: "parent",
      turnId: "turn"
    })
    manager.bindThread({ ...instance.authority, runtimeAuthority: instance.authority })
    manager.bindFunctionSession(instance.authority, "custom:model")
    const lifetime = new AbortController()
    const terminal = Promise.withResolvers<FunctionTurnComplete>()
    let assertResource!: () => void
    let assertNewGuestCall!: () => void
    let activation: DevelopmentActivation | undefined
    let sourceCurrent = true
    const sourceGuard = () => {
      if (!sourceCurrent) throw Error("MODS_DEVELOPMENT_SOURCE_CHANGED")
    }
    const scope = {
      workspace,
      threadId: "parent",
      incarnation: { token: "real-owner", legacyCreatedAt: 1 }
    }
    const sessions = new FunctionDevelopmentSessions({
      assertScope: () => {},
      prepare: async () => ({ dispose: async () => {} }),
      retire: async () => {},
      activate: (next) => {
        activation = next
      },
      changed: () => {}
    })
    const revision = {
      componentId: "owned-child",
      draftId: "draft",
      revision: 1,
      sourcePath: root,
      bundleDigest: "a".repeat(64),
      compiledDigest: "b".repeat(64),
      turnId: "creation",
      validation: "authorized-real" as const,
      purpose: "Owned background agent test",
      capabilities: ["agent.spawn"]
    }
    let completion: Promise<FunctionTurnComplete> | undefined
    try {
      sessions.stage(scope, revision, sourceGuard)
      sessions.approve(
        scope,
        revision.componentId,
        revision.compiledDigest,
        revision.capabilities,
        () => {}
      )
      sessions.noteSettled(scope, revision.turnId, "completed")
      await vi.waitFor(() => expect(activation).toBeDefined())
      hooks.run.mockImplementation(
        async (
          host: ModsManager,
          plan: { workspace: string },
          context: {
            agentId: string
            signal: AbortSignal
            started(id: string): void
            assertLive(): void
          }
        ) => {
          const physical = `physical:${context.agentId}`
          const child = host.createRuntimeAuthority({
            workspace: plan.workspace,
            threadId: physical,
            agentId: context.agentId,
            turnId: "child-turn",
            signal: context.signal
          })
          host.bindFunctionPeerEndpoint(child.authority)
          assertResource = AsyncResource.bind(context.assertLive)
          context.assertLive()
          context.started(physical)
          try {
            return await terminal.promise
          } finally {
            host.closeFunctionThread(physical)
          }
        }
      )
      const spawned = await withFunctionAgentExecution(
        {
          workspace,
          threadId: "parent",
          turnId: "turn",
          agentId: "main",
          runtimeAuthority: instance.authority,
          leased: false,
          immediate: false,
          userInitiated: false
        },
        async () => {
          const input = await withDevelopmentNativeAuthority(
            manager.store,
            workspace,
            "parent",
            activation!,
            "agent.spawn",
            (grant) =>
              manager.prepareFunctionAgentSpawn(
                workspace,
                "parent",
                grant,
                { prompt: "Review changes" },
                lifetime.signal
              )
          )
          return withDevelopmentNativeAuthority(
            manager.store,
            workspace,
            "parent",
            activation!,
            "agent.spawn",
            async (grant) => {
              assertNewGuestCall = AsyncResource.bind(() => manager.store.assertGrant(grant))
              return manager.spawnFunctionAgent(
                workspace,
                "parent",
                grant,
                input,
                lifetime.signal,
                lifetime.signal
              )
            }
          )
        }
      )
      completion = spawned.completion
      expect(spawned.value.agentId).toBeDefined()
      expect(() => assertNewGuestCall()).toThrow()
      expect(() => assertResource()).not.toThrow()
      expect(() => assertNewGuestCall()).toThrow()
      if (kind === "stop") await sessions.stop(scope, revision.componentId, () => {})
      else if (kind === "source") sourceCurrent = false
      else {
        const next = {
          ...revision,
          revision: 2,
          compiledDigest: "c".repeat(64),
          turnId: "narrowing",
          capabilities: []
        }
        sessions.stage(scope, next, sourceGuard)
        sessions.noteSettled(scope, next.turnId, "completed")
        await vi.waitFor(() => expect(activation!.revision.revision).toBe(2))
      }
      expect(() => assertResource()).toThrow()
    } finally {
      lifetime.abort()
      terminal.resolve({
        answer: "done",
        reason: "answer",
        isAborted: false,
        durationMs: 1,
        turnId: "child-turn"
      })
      await completion?.catch(() => {})
      sessions.close()
      manager.close()
      await rm(root, { recursive: true, force: true })
      hooks.run.mockReset()
    }
  }
)
