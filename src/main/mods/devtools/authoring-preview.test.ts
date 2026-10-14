import { afterEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { FunctionGuestRuntime } from "../v2/guest-runtime"
import { createAuthoringTemplate, AUTHORING_TEMPLATE_KINDS } from "./authoring-templates"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import { previewAuthoringSource, type AuthoringPreviewAction } from "./authoring-preview"
import { analyzeAuthoringPreview } from "./authoring-preflight"

const cleanup = vi.hoisted(() => ({ after: undefined as (() => void) | undefined }))
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>()
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await actual.rm(...args)
      cleanup.after?.()
    }
  }
})
afterEach(() => {
  cleanup.after = undefined
})

function backend() {
  let disposed = false
  let stopped = false
  let calls = 0
  let pluginRoot = ""
  return {
    stats: () => ({ disposed, stopped, calls, pluginRoot }),
    create: () => ({
      preflight: analyzeAuthoringPreview,
      load: async (...args: Parameters<typeof FunctionGuestRuntime.create>) => {
        calls++
        const guest = await FunctionGuestRuntime.create(...args)
        const invoke = guest.invoke.bind(guest)
        guest.invoke = (...invocation) => {
          pluginRoot = invocation[3].plugin.root
          return invoke(...invocation)
        }
        const dispose = guest.dispose.bind(guest)
        guest.dispose = async () => {
          await dispose()
          disposed = true
        }
        return guest
      },
      stop: async () => {
        stopped = true
      }
    })
  }
}

const inspect: AuthoringPreviewAction = { kind: "inspect", target: "", input: "" }
describe("real authoring preview invocation", () => {
  it.each(["scope", "abort"])(
    "rejects %s revoked during final filesystem cleanup",
    async (reason) => {
      const source = createAuthoringTemplate({
        kind: "command",
        id: "cleanup",
        name: "cleanup",
        instruction: "test"
      })
      const host = backend(),
        controller = new AbortController()
      let current = true
      cleanup.after = () => {
        if (reason === "scope") current = false
        else controller.abort(Error("late-abort"))
      }
      await expect(
        previewAuthoringSource(source, inspect, {
          backend: host.create,
          signal: controller.signal,
          assertCurrent: () => {
            if (!current) throw Error("late-scope")
          }
        })
      ).rejects.toThrow(reason === "scope" ? "late-scope" : "late-abort")
      expect(host.stats()).toMatchObject({ stopped: true, disposed: true })
      expect(existsSync(host.stats().pluginRoot)).toBe(false)
    }
  )

  it("rechecks an abort triggered inside the final scope guard", async () => {
    const source = createAuthoringTemplate({
      kind: "command",
      id: "guard",
      name: "guard",
      instruction: "test"
    })
    const host = backend(),
      controller = new AbortController()
    await expect(
      previewAuthoringSource(source, inspect, {
        backend: host.create,
        signal: controller.signal,
        assertCurrent: () => {
          if (host.stats().disposed) controller.abort(Error("guard-abort"))
        }
      })
    ).rejects.toThrow("guard-abort")
    expect(existsSync(host.stats().pluginRoot)).toBe(false)
  })
  it.each(AUTHORING_TEMPLATE_KINDS)(
    "executes the actual %s template and cleans its isolated session",
    async (kind) => {
      const source = createAuthoringTemplate({
        kind,
        id: "preview-demo",
        name: "预览",
        instruction: "整理输入"
      })
      const host = backend()
      const action: AuthoringPreviewAction =
        kind === "tool"
          ? { kind: "tool", target: "mcp__preview-demo__format", input: '{"text":"样例"}' }
          : kind === "rule"
            ? { kind: "rule", target: "", input: "样例" }
            : { kind: "command", target: "preview-demo", input: "样例" }
      const report = await previewAuthoringSource(source, action, {
        backend: host.create,
        assertCurrent: () => {},
        signal: new AbortController().signal
      })
      expect(report.sourceDigest).toBe(source.digest)
      expect(report.failures).toBe(0)
      expect(report.authorized).toBe(false)
      expect(report.scope).toBe("isolated-invocation")
      if (kind === "panel") expect(JSON.stringify(report.panes)).toContain("整理输入")
      else expect(JSON.stringify(report.result)).toContain("整理输入")
      expect(host.stats()).toMatchObject({ calls: 1, stopped: true, disposed: true })
      expect(existsSync(host.stats().pluginRoot)).toBe(false)
    }
  )

  it("does not turn denied SDK access recovered by optional hooks into a clean preview", async () => {
    const source = createAuthoringTemplate({
      kind: "rule",
      id: "denied",
      name: "denied",
      instruction: "test"
    })
    const hostile = createAuthoringSourceBundle(
      source.files.map((file) =>
        file.path === "mods/main.ts"
          ? {
              ...file,
              text: 'export function register(on){on("prompt.compose",async($,event,next)=>{await $.fs.read("secret.txt");return next(event)})}'
            }
          : file
      )
    )
    const host = backend()
    const report = await previewAuthoringSource(
      hostile,
      { kind: "rule", target: "", input: "safe" },
      {
        backend: host.create,
        assertCurrent: () => {},
        signal: new AbortController().signal
      }
    )
    expect(report.failures).toBeGreaterThan(0)
    expect(JSON.stringify(report.result)).toContain("safe")
    expect(host.stats().disposed).toBe(true)
  })

  it("rejects unregistered tools without dispatching external capabilities", async () => {
    const source = createAuthoringTemplate({
      kind: "tool",
      id: "example",
      name: "test",
      instruction: "test"
    })
    const host = backend()
    await expect(
      previewAuthoringSource(
        source,
        { kind: "tool", target: "shell", input: "{}" },
        {
          backend: host.create,
          assertCurrent: () => {},
          signal: new AbortController().signal
        }
      )
    ).rejects.toThrow("AUTHORING_PREVIEW_TOOL_MISSING")
    expect(host.stats()).toMatchObject({ stopped: true, disposed: true })
  })

  it("rejects cancellation and changed scope before loading guest code", async () => {
    const source = createAuthoringTemplate({
      kind: "command",
      id: "example",
      name: "test",
      instruction: "test"
    })
    const host = backend()
    const controller = new AbortController()
    controller.abort(Error("cancelled"))
    await expect(
      previewAuthoringSource(source, inspect, {
        backend: host.create,
        assertCurrent: () => {},
        signal: controller.signal
      })
    ).rejects.toThrow("cancelled")
    await expect(
      previewAuthoringSource(source, inspect, {
        backend: host.create,
        assertCurrent: () => {
          throw Error("scope-changed")
        },
        signal: new AbortController().signal
      })
    ).rejects.toThrow("scope-changed")
    expect(host.stats().calls).toBe(0)
  })

  it("captures source before an async caller edit and disposes a late guest after revocation", async () => {
    const source = createAuthoringTemplate({
      kind: "command",
      id: "example",
      name: "test",
      instruction: "original"
    })
    const host = backend()
    let current = true
    await expect(
      previewAuthoringSource(source, inspect, {
        backend: () => ({
          ...host.create(),
          load: async (...args) => {
            const guest = await host.create().load(...args)
            current = false
            return guest
          }
        }),
        assertCurrent: () => {
          if (!current) throw Error("scope-changed")
        },
        signal: new AbortController().signal
      })
    ).rejects.toThrow("scope-changed")
    expect(host.stats()).toMatchObject({ stopped: true, disposed: true })
  })

  it("rejects hostile action accessors without executing them", async () => {
    const source = createAuthoringTemplate({
      kind: "command",
      id: "example",
      name: "test",
      instruction: "test"
    })
    let reads = 0
    await expect(
      previewAuthoringSource(
        source,
        {
          get kind() {
            reads++
            return "inspect"
          },
          target: "",
          input: ""
        },
        {
          backend: backend().create,
          assertCurrent: () => {},
          signal: new AbortController().signal
        }
      )
    ).rejects.toThrow("AUTHORING_PREVIEW_INPUT")
    expect(reads).toBe(0)
  })
})
