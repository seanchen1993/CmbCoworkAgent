import { mkdtemp, writeFile, rm, symlink, link } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { createEditorPlatformProvider } from "./platform-editor-provider"
import { EditorNavigationBroker } from "./platform-editor-navigation"
import type { NativePlatformCallContext } from "./platform-capabilities-types"
import type { DeveloperEditorEvent } from "../../../shared/mods/v2/developer-editor"

const roots: string[] = [],
  brokers: EditorNavigationBroker[] = []
afterEach(async () => {
  brokers.splice(0).forEach((broker) => broker.invalidate())
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "native-editor-"))
  roots.push(workspace)
  await writeFile(
    join(workspace, "source.html"),
    "<script>globalThis.BAD=true</script>\n中文 target\n"
  )
  const events: DeveloperEditorEvent[] = []
  const navigation = new EditorNavigationBroker(
    () => 7,
    (_sender, event) => events.push(event)
  )
  brokers.push(navigation)
  let valid = true
  const context: NativePlatformCallContext = {
    workspace,
    threadId: "thread",
    incarnation: "birth",
    generation: "native",
    caller: { name: "author", provider: "author", digest: "digest", generation: "source" },
    signal: new AbortController().signal,
    assertCurrent: () => {
      if (!valid) throw Error("REVOKED")
    },
    publish() {
      /* This navigation never publishes guest state. */
    },
    invoke: async () => ({ requestKey: "key", status: "succeeded" })
  }
  let leaseClosed = 0
  context.captureReadLease = () => {
    const controller = new AbortController()
    const retained: NativePlatformCallContext = {
      ...context,
      signal: controller.signal,
      assertCurrent: () => {
        controller.signal.throwIfAborted()
        if (!valid) throw Error("REVOKED")
      },
      captureReadLease: () => {
        throw Error("READ_ONLY")
      },
      publish: () => {
        throw Error("READ_ONLY")
      },
      invoke: () => {
        throw Error("READ_ONLY")
      }
    }
    return {
      context: retained,
      validate: async () => retained.assertCurrent(),
      close: () => {
        if (!controller.signal.aborted) {
          leaseClosed++
          controller.abort()
        }
      }
    }
  }
  const authorizePath = vi.fn(async () => {})
  const openExternal = vi.fn(async () => ({ mode: "workspace+file" }))
  const provider = createEditorPlatformProvider({
    navigation,
    authorizePath,
    rendererScope: () => "birth",
    openExternal
  })
  return {
    workspace,
    events,
    navigation,
    context,
    authorizePath,
    leaseClosed: () => leaseClosed,
    openExternal,
    provider,
    revoke: () => {
      valid = false
    }
  }
}
it("previews bounded UTF-8 source and reports only the exact native receipt", async () => {
  const f = await fixture()
  const result = f.provider.act(f.context, "preview", { path: "source.html", line: 2, column: 3 })
  await vi.waitFor(() => expect(f.events[0]?.kind).toBe("offer"))
  const event = f.events[0]
  if (event.kind !== "offer") throw Error("NO_OFFER")
  const frame = await f.navigation.accept(7, event.intent.id)
  expect(frame.text).toContain("<script>")
  await f.navigation.acknowledge(7, {
    id: frame.id,
    fingerprint: frame.fingerprint,
    status: "preview-loaded",
    line: 2,
    column: 3
  })
  await expect(result).resolves.toMatchObject({ status: "preview-loaded" })
  expect(f.authorizePath.mock.calls.length).toBeGreaterThanOrEqual(3)
  expect(f.provider.queryActions).toBeUndefined()
})
it.each(["../secret", "/absolute", "C:/absolute", ".env", "source.html?script", "missing"])(
  "rejects unsupported path %s",
  async (path) => {
    const f = await fixture()
    await expect(f.provider.act(f.context, "preview", { path })).rejects.toThrow()
    expect(f.events).toHaveLength(0)
  }
)
it.each(["binary", "utf8", "large", "position", "denied"])(
  "rejects %s before navigation",
  async (kind) => {
    const f = await fixture()
    if (kind === "binary") await writeFile(join(f.workspace, "source.html"), Buffer.from([0]))
    if (kind === "utf8") await writeFile(join(f.workspace, "source.html"), Buffer.from([0xff]))
    if (kind === "large") await writeFile(join(f.workspace, "source.html"), "x".repeat(65537))
    if (kind === "denied") f.authorizePath.mockRejectedValue(Error("DENIED"))
    await expect(
      f.provider.act(f.context, "preview", {
        path: "source.html",
        ...(kind === "position" ? { line: 50 } : {})
      })
    ).rejects.toThrow()
    expect(f.events).toHaveLength(0)
  }
)
it("rejects changed bytes after the offer and pins cached receipt access", async () => {
  const f = await fixture()
  const before = await f.provider.prepareActionAccess!(f.context, "preview", {
    path: "source.html"
  })
  const result = f.provider.act(f.context, "preview", { path: "source.html" })
  await vi.waitFor(() => expect(f.events[0]?.kind).toBe("offer"))
  await writeFile(join(f.workspace, "source.html"), "new bytes")
  const event = f.events[0]
  if (event.kind !== "offer") throw Error("NO_OFFER")
  await expect(f.navigation.accept(7, event.intent.id)).rejects.toThrow("FILE_CHANGED")
  await expect(result).resolves.toMatchObject({ status: "unknown" })
  const after = await f.provider.prepareActionAccess!(f.context, "preview", { path: "source.html" })
  expect(after!.identity).not.toBe(before!.identity)
})
it("retireOwner closes a pending preview on provider shutdown", async () => {
  const f = await fixture()
  const result = f.provider.act(f.context, "preview", { path: "source.html" })
  await vi.waitFor(() => expect(f.events[0]?.kind).toBe("offer"))
  f.provider.close!()
  await expect(result).resolves.toMatchObject({ status: "unknown" })
})
it("rejects a hardlinked file", async () => {
  const f = await fixture()
  await link(join(f.workspace, "source.html"), join(f.workspace, "hard.html"))
  await expect(f.provider.act(f.context, "preview", { path: "hard.html" })).rejects.toThrow()
})
it("rechecks the original read policy after offering a preview", async () => {
  const f = await fixture()
  const result = f.provider.act(f.context, "preview", { path: "source.html" })
  await vi.waitFor(() => expect(f.events[0]?.kind).toBe("offer"))
  f.authorizePath.mockRejectedValue(Error("POLICY_CHANGED"))
  const event = f.events[0]
  if (event.kind !== "offer") throw Error("NO_OFFER")
  await expect(f.navigation.accept(7, event.intent.id)).rejects.toThrow("POLICY_CHANGED")
  await expect(result).resolves.toMatchObject({ status: "unknown" })
})
it("bounds concurrent preparation reads until their actual completion", async () => {
  const f = await fixture()
  let finish!: () => void
  const held = new Promise<void>((done) => {
    finish = done
  })
  f.authorizePath.mockImplementation(async () => held)
  const pending = Array.from({ length: 4 }, () =>
    f.provider.prepareActionAccess!(f.context, "preview", { path: "source.html" })
  )
  await expect(
    f.provider.prepareActionAccess!(f.context, "preview", {
      path: "source.html"
    })
  ).rejects.toThrow("READ_BUSY")
  finish()
  await Promise.all(pending)
  await expect(
    f.provider.prepareActionAccess!(f.context, "preview", {
      path: "source.html"
    })
  ).resolves.toBeDefined()
})
it.runIf(process.platform !== "win32")(
  "rejects a symbolic link without reading its target",
  async () => {
    const f = await fixture()
    await symlink(join(f.workspace, "source.html"), join(f.workspace, "link.html"))
    await expect(f.provider.act(f.context, "preview", { path: "link.html" })).rejects.toThrow()
  }
)

it("fails closed when a main read lease cannot be captured after real target ACK", async () => {
  const f = await fixture()
  f.context.captureReadLease = undefined
  const result = f.provider.act(f.context, "preview", { path: "source.html", line: 2, column: 3 })
  await vi.waitFor(() => expect(f.events[0]?.kind).toBe("offer"))
  const event = f.events[0]
  if (event.kind !== "offer") throw Error("NO_OFFER")
  const frame = await f.navigation.accept(7, event.intent.id)
  await expect(
    f.navigation.acknowledge(7, {
      id: frame.id,
      fingerprint: frame.fingerprint,
      status: "preview-loaded",
      line: 2,
      column: 3
    })
  ).rejects.toThrow("RETENTION_UNAVAILABLE")
  await expect(result).resolves.toMatchObject({ status: "unknown" })
})

it("revalidates retained ancestor authority after the asynchronous original path probe", async () => {
  const f = await fixture()
  let authorityValid = true
  const capture = f.context.captureReadLease!
  f.context.captureReadLease = () => {
    const lease = capture()
    return {
      ...lease,
      validate: async () => {
        if (!authorityValid) throw Error("ANCESTOR_AUTHORITY_CHANGED")
        await lease.validate()
      }
    }
  }
  const result = f.provider.act(f.context, "preview", { path: "source.html", line: 2, column: 3 })
  await vi.waitFor(() => expect(f.events[0]?.kind).toBe("offer"))
  const event = f.events[0]
  if (event.kind !== "offer") throw Error("NO_OFFER")
  const frame = await f.navigation.accept(7, event.intent.id)
  await f.navigation.acknowledge(7, {
    id: frame.id,
    fingerprint: frame.fingerprint,
    status: "preview-loaded",
    line: 2,
    column: 3
  })
  await result
  f.authorizePath.mockImplementation(async () => {
    authorityValid = false
  })
  await expect(f.navigation.launchExternal(7, frame.id)).rejects.toThrow(
    "ANCESTOR_AUTHORITY_CHANGED"
  )
  expect(f.openExternal).not.toHaveBeenCalled()
  expect(f.leaseClosed()).toBe(1)
})
