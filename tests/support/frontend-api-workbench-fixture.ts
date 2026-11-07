import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { compileFunctionPlugin } from "../../src/main/mods/v2/loader"
import { FunctionGuestRuntime } from "../../src/main/mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../../src/main/mods/v2/session"
import { FunctionPluginPromptQueue } from "../../src/main/mods/v2/plugin-prompt-queue"
import { FunctionSessionActivity } from "../../src/main/mods/v2/session-activity"
import { FunctionSessionInitializer } from "../../src/main/mods/v2/session-initializer"
import { trackFunctionGuest } from "../../src/main/mods/v2/session-guest"
import type { ModJson, ModObject } from "../../src/shared/mods/types"
import type {
  FunctionPaneSnapshot,
  FunctionUiElement,
  FunctionUiNode
} from "../../src/shared/mods/v2/ui"

const directory = resolve("examples/frontend-api-workbench")
const tools = ["navigate", "snapshot", "network_requests", "console_messages"].map((suffix) => ({
  name: "mcp__inAppBrowser__browser_" + suffix,
  description: suffix,
  mcp: true
}))

export function findWorkbenchNode(
  tree: FunctionUiElement,
  key: string
): FunctionUiNode | undefined {
  if (tree.type === "engine") return undefined
  if (tree.type !== "fragment" && tree.props.key === key) return tree as FunctionUiNode
  for (const child of tree.children ?? []) {
    if (typeof child === "string") continue
    const found = findWorkbenchNode(child, key)
    if (found) return found
  }
  return undefined
}

export async function createFrontendWorkbenchFixture(
  options: {
    unavailable?: boolean
    reject?: boolean
    drop?: boolean
    policy?: "drop-after-core" | "handled-locally" | "reject-after-core"
    saved?: ModJson
    cwd?: string
  } = {}
) {
  const compiled = await compileFunctionPlugin(directory, { captureSources: true })
  const runtime = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  const activity = new FunctionSessionActivity()
  const guest = trackFunctionGuest(runtime, activity, new FunctionSessionInitializer(false))
  const stored = new Map<string, ModJson>()
  if (options.saved) stored.set("draft", options.saved)
  const runs: ModObject[] = []
  const idleListeners = new Set<(threadId: string) => void>()
  const threadId = randomUUID()
  const finish = Promise.withResolvers<void>()
  let busy = true
  let toolLists = 0
  const queue = new FunctionPluginPromptQueue({
    busy: () => busy,
    claim: () => ({ assertCurrent() {}, release() {} }),
    run: async (_scope, input, _framed, _lease, _signal, started) => {
      runs.push(input)
      started()
      await finish.promise
    },
    onIdle(listener) {
      idleListeners.add(listener)
      return () => {
        idleListeners.delete(listener)
      }
    }
  })
  const session = new FunctionSession(
    [
      {
        name: compiled.name,
        root: compiled.root,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      },
      ...(options.drop || options.policy
        ? [
            {
              name: "submission-policy",
              root: "/submission-policy",
              tier: "user" as const,
              capabilities: [...SESSION_CAPABILITIES],
              guest: await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
          on("prompt.submit", async (_$, event, next) => {
            if (${JSON.stringify(options.policy)} === "handled-locally")
              return {text:"当前策略已在本地处理请求"};
            if (${JSON.stringify(options.policy)} === "drop-after-core") {
              await next(event);
              return {drop:"当前策略返回取消提示"};
            }
            if (${JSON.stringify(options.policy)} === "reject-after-core") return next(event);
            return {drop:"联调任务被当前策略取消"};
          });
        }}`)
            }
          ]
        : [])
    ],
    {
      workspace: "/workbench-fixture",
      cwd: () => options.cwd ?? "/workbench-fixture/source",
      threadId,
      activity,
      assertLive() {},
      publish: async (value) => value,
      readSession: async (method) => {
        if (method !== "session.model") throw Error("Unexpected read: " + method)
        return "current-chat-model"
      },
      listTools: async () => {
        toolLists++
        return options.unavailable ? [] : tools
      },
      reservePluginPrompt: (_plugin, origin, signal) =>
        queue.reserve({
          workspace: "/workbench-fixture",
          threadId,
          origin,
          signal,
          assertLive() {}
        }),
      preparePluginPrompt: async (_plugin, signal, assertAdmission, _cancel, run) => {
        signal.throwIfAborted()
        assertAdmission()
        if (options.reject) throw Error("Fixture submission rejected")
        const result = await run(assertAdmission)
        if (options.policy === "reject-after-core")
          throw Error("Fixture reply failed after acceptance")
        return result
      },
      state: () => ({
        get: async (key) => stored.get(key),
        set: async (key, value) => {
          stored.set(key, value)
        },
        keys: async () => [...stored.keys()],
        delete: (key) => {
          stored.delete(key)
        }
      })
    }
  )
  const close = async () => {
    finish.resolve()
    queue.close()
    await session.close()
    activity.close()
  }
  await session.start()
  const siteOwner = await session.sites.mount("ChatHeader")
  const snapshot = () =>
    session.sites.render(siteOwner, {
      isWorking: false,
      bodyColumns: 80,
      maxRows: 14,
      offset: 0
    })
  const action = (
    pane: FunctionPaneSnapshot,
    key: string,
    kind: "press" | "change",
    value?: string
  ) => {
    const node = findWorkbenchNode(pane.tree, key)
    if (!node) throw Error("Workbench control missing: " + key)
    return session.sites.act(siteOwner, {
      pane: pane.key,
      generation: pane.generation,
      intentId: randomUUID(),
      plugin: node.press!.plugin,
      handle: node.press!.handle,
      kind,
      ...(value === undefined ? {} : { value })
    })
  }
  const fill = async () => {
    await action(await snapshot(), "use-cwd", "press")
    await action(await snapshot(), "toggle-focus", "press")
    await action(await snapshot(), "url", "change", "http://localhost:4179/orders")
    await action(
      await snapshot(),
      "document",
      "change",
      "GET /api/orders 返回 amountCents，以分为单位。"
    )
    await action(await snapshot(), "focus", "change", "为什么金额是 0？")
  }
  return {
    siteOwner,
    session,
    queue,
    stored,
    runs,
    snapshot,
    action,
    fill,
    close,
    facts: () => ({ toolLists }),
    idle() {
      busy = false
      idleListeners.forEach((listener) => listener(threadId))
    }
  }
}
