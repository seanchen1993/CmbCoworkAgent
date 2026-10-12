/** Actual production callbacks, with framework/storage/API ports. Chrome coverage is separate. */
import { build } from "esbuild"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { createRequire } from "node:module"
const root = fileURLToPath(new URL("../", import.meta.url))
const scratch = await fs.mkdtemp(path.join(tmpdir(), "cmb-editor-epoch-callbacks-"))
try {
  const require = createRequire(import.meta.url)
  const bundle = await build({
    stdin: {
      contents: `export{BotProfileInlineEditor}from'./src/renderer/src/components/bots/BotProfileInlineEditor';export{BotEditor}from'./src/renderer/src/components/bots/BotEditor';export{BotGroupEditor}from'./src/renderer/src/components/bots/BotGroupEditor';export{BotGroupMembers}from'./src/renderer/src/components/bots/BotGroupMembers';export{createBotQuickCreateController}from'./src/renderer/src/lib/bot-quick-create';export{BotDomainError}from'./src/shared/bot-types'`,
      resolveDir: root,
      loader: "tsx"
    },
    bundle: true,
    preserveSymlinks: true,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    write: false,
    nodePaths: [path.resolve(root, "node_modules")],
    alias: { "@": path.resolve(root, "src/renderer/src") },
    plugins: [
      {
        name: "actual-editor-port-proof",
        setup(b) {
          b.onResolve({ filter: /^(react|react\/jsx-runtime)$/ }, (a) => ({
            path: a.path,
            namespace: "ports"
          }))
          b.onResolve({ filter: /bot-api$/ }, () => ({ path: "api", namespace: "ports" }))
          b.onResolve({ filter: /bot-workspace-store$/ }, () => ({
            path: "workspace",
            namespace: "ports"
          }))
          b.onResolve({ filter: /^@\/lib\/store$/ }, () => ({ path: "app", namespace: "ports" }))
          b.onResolve(
            {
              filter:
                /^lucide-react$|^sonner$|^@\/components\/ui\/|^\.\/Bot(Dialog|PendingSaveRecovery|PersonaChooser|ModelChecks|ConnectorPicker|HarnessBindingPicker|Avatar|ErrorNoticeBody)$|^@\/lib\/utils$/
            },
            () => ({ path: "ui", namespace: "ports" })
          )
          b.onResolve({ filter: /\.css$/ }, () => ({ path: "css", namespace: "ports" }))
          b.onLoad({ filter: /.*/, namespace: "ports" }, (a) => ({
            loader: "js",
            contents:
              a.path === "react"
                ? `export const useState=(v)=>globalThis.proof.react.useState(v);export const useRef=(v)=>globalThis.proof.react.useRef(v);export const useId=()=>globalThis.proof.react.useId();export const useEffect=(f,d)=>globalThis.proof.react.useEffect(f,d);export const useLayoutEffect=useEffect;`
                : a.path === "react/jsx-runtime"
                  ? `export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment='fragment';`
                  : a.path === "api"
                    ? `export const botApi=globalThis.proof.api;`
                    : a.path === "workspace"
                      ? `export const useBotWorkspaceStore=(s)=>s(globalThis.proof.state);useBotWorkspaceStore.getState=()=>globalThis.proof.state;`
                      : a.path === "app"
                        ? `export const useAppStore=(s)=>s({models:[]});`
                        : a.path === "css"
                          ? ""
                          : `export const ${["LoaderCircle", "ChevronRight", "Loader2", "Plus", "Search", "X", "Button", "Input", "Select", "SelectTrigger", "SelectValue", "SelectContent", "SelectItem", "Dialog", "DialogDescription", "DialogHeader", "DialogTitle", "Popover", "PopoverContent", "PopoverTrigger", "BotDialogContent", "BotPendingSaveRecovery", "BotPersonaChooser", "BotModelChecks", "BotConnectorPicker", "BotHarnessBindingPicker", "BotAvatar", "BotErrorNoticeBody"].map((n) => `${n}=${JSON.stringify(n)}`).join(",")};export const cn=(...args)=>args.join(' ');export const toast={info:()=>{}};`
          }))
        }
      }
    ]
  })
  const bundlePath = path.join(scratch, "actual.cjs")
  await fs.writeFile(bundlePath, bundle.outputFiles[0].text)
  let slots = [],
    index = 0,
    effects = [],
    cleanup = [],
    values = new Map(),
    calls = [],
    release,
    rerender,
    exits
  function install() {
    slots = []
    index = 0
    effects = []
    cleanup = []
    values = new Map()
    calls = []
    release = null
    exits = 0
    globalThis.localStorage = {
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => values.set(k, v),
      removeItem: (k) => values.delete(k)
    }
    globalThis.proof = {
      state: {
        snapshot: { dataEpoch: "before", bots: [], conversations: [] },
        host: {
          capabilities: [
            "bot-update-receipts",
            "bot-profile-title",
            "scoped-bot-create",
            "group-update-receipts",
            "group-member-controls",
            "mutation-data-epoch-v2"
          ]
        },
        selected: "old",
        viewportLease: { viewId: "old", generation: 1 },
        refresh: async () => calls.push("refresh")
      },
      api: new Proxy(
        {},
        {
          get: (_, method) => (input) => {
            calls.push({ method, input })
            return new Promise((resolve, reject) => (release = { resolve, reject }))
          }
        }
      ),
      react: {
        useState(v) {
          const i = index++
          if (!(i in slots)) slots[i] = typeof v === "function" ? v() : v
          return [
            slots[i],
            (n) => {
              slots[i] = typeof n === "function" ? n(slots[i]) : n
            }
          ]
        },
        useRef(v) {
          const i = index++
          if (!(i in slots)) slots[i] = { current: v }
          return slots[i]
        },
        useId() {
          const i = index++
          if (!(i in slots)) slots[i] = `proof-id-${i}`
          return slots[i]
        },
        useEffect(f, dependencies) {
          const i = index++
          if (!(i in slots)) {
            slots[i] = { dependencies: undefined, cleanup: undefined }
            cleanup.push(() => slots[i].cleanup?.())
          }
          const previous = slots[i]
          if (
            dependencies &&
            previous.dependencies &&
            dependencies.length === previous.dependencies.length &&
            dependencies.every((value, position) =>
              Object.is(value, previous.dependencies[position])
            )
          )
            return
          previous.dependencies = dependencies
          effects.push(() => {
            previous.cleanup?.()
            previous.cleanup = f()
          })
        }
      }
    }
  }
  install()
  const actual = require(bundlePath)
  const bot = {
    id: "bot",
    name: "Alpha",
    title: "",
    revision: 1,
    instructions: "",
    connectorIds: [],
    modelRef: null,
    workspacePath: null,
    avatarShape: null,
    avatarColor: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    hidden: false,
    pinned: false
  }
  const beta = { ...bot, id: "beta", name: "Beta" }
  const group = {
    id: "group",
    kind: "group",
    name: "Team",
    description: "",
    revision: 1,
    members: ["bot", "beta"],
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null
  }
  function find(tree, predicate) {
    if (tree && typeof tree === "object") {
      if (predicate(tree)) return tree
      for (const child of [tree.props?.children].flat(Infinity)) {
        const match = find(child, predicate)
        if (match) return match
      }
    }
    return null
  }
  async function flush() {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }
  function start(name, beforeDispatch = () => undefined) {
    globalThis.proof.state.snapshot.bots = [bot, beta]
    globalThis.proof.state.snapshot.conversations = [group]
    if (name === "QuickCreate") {
      const c = actual.createBotQuickCreateController({
        scope: () => ({
          dataEpoch: globalThis.proof.state.snapshot.dataEpoch,
          selected: "old",
          lease: { viewId: "old", generation: 1 },
          capabilities: ["scoped-bot-create", "mutation-data-epoch-v2"]
        }),
        defaults: () => ({
          name: "New",
          instructions: "",
          modelRef: null,
          workspacePath: null,
          connectorIds: [],
          avatarShape: null,
          avatarColor: null
        }),
        create: (input) => globalThis.proof.api.create(input),
        refresh: globalThis.proof.state.refresh,
        select: () => exits++,
        nonce: () => "fixed-nonce"
      })
      c.start()
      return () => c.dispose()
    }
    let props =
      name === "Inline"
        ? { bot, dataEpoch: "before", field: "name", onExit: () => exits++ }
        : name === "Editor"
          ? { bot, close: () => exits++, created: () => exits++ }
          : name === "GroupEditor"
            ? { bots: [bot, beta], group, close: () => exits++, created: () => exits++ }
            : { bots: [bot, beta], group, openBot: () => exits++ }
    const component =
      actual[
        name === "Inline"
          ? "BotProfileInlineEditor"
          : name === "Editor"
            ? "BotEditor"
            : name === "GroupEditor"
              ? "BotGroupEditor"
              : "BotGroupMembers"
      ]
    rerender = () => {
      index = 0
      const tree = component(props)
      for (const f of effects.splice(0)) {
        const c = f()
        if (c) cleanup.push(c)
      }
      return tree
    }
    let tree = rerender()
    if (name !== "Members") beforeDispatch()
    if (name === "Inline")
      find(tree, (n) => n.type === "input").props.onBlur({ currentTarget: { value: "Changed" } })
    else if (name === "Members") {
      find(tree, (n) => n.props?.["aria-label"] === "移除 Beta").props.onClick({
        currentTarget: {}
      })
      tree = rerender()
      beforeDispatch()
      find(tree, (n) => n.type === "Button" && n.props.children === "移出群聊").props.onClick()
    } else
      find(tree, (n) => n.type === "form").props.onSubmit({
        preventDefault() {
          return undefined
        }
      })
    return () => cleanup.forEach((f) => f())
  }
  const results = []
  for (const name of ["Inline", "Editor", "QuickCreate", "GroupEditor", "Members"])
    for (const outcome of ["success", "rejection"])
      for (const transition of ["restore", "unmount"]) {
        install()
        const stop = start(name)
        assert.ok(release, `${name} actually dispatches`)
        assert.equal(values.size, 1)
        const original = [...values.values()][0]
        if (transition === "restore")
          globalThis.proof.state.snapshot = {
            ...globalThis.proof.state.snapshot,
            dataEpoch: "after"
          }
        else stop()
        if (outcome === "rejection")
          release.reject(
            new actual.BotDomainError(
              name === "QuickCreate" ? "invalid_input" : "revision_conflict",
              "rejected"
            )
          )
        else
          release.resolve(
            name === "QuickCreate"
              ? { bot: { ...bot, name: "New" }, conversationId: "conversation" }
              : name === "GroupEditor" || name === "Members"
                ? {
                    ...group,
                    members: calls.find((call) => typeof call === "object").input.members
                  }
                : bot
          )
        await flush()
        const expected = transition === "restore" ? 1 : 0
        const kept = values.size
        results.push({
          name,
          outcome,
          transition,
          expectedRecords: expected,
          actualRecords: kept,
          originalSurvives: values.get([...values.keys()][0]) === original,
          exits,
          pass: kept === expected && exits === 0
        })
      }
  // A replaced-workspace rejection cannot acknowledge an intent from the old
  // database, even when the old component has already unmounted.
  for (const transition of ["restore", "unmount"]) {
    install()
    const stop = start("QuickCreate")
    assert.ok(release)
    const original = [...values.values()][0]
    if (transition === "restore")
      globalThis.proof.state.snapshot = { ...globalThis.proof.state.snapshot, dataEpoch: "after" }
    else stop()
    release.reject(new actual.BotDomainError("workspace_replaced", "replaced"))
    await flush()
    results.push({
      name: "QuickCreate",
      outcome: "workspace_replaced",
      transition,
      expectedRecords: 1,
      actualRecords: values.size,
      originalSurvives: [...values.values()][0] === original,
      exits,
      pass: values.size === 1 && [...values.values()][0] === original && exits === 0
    })
  }
  for (const name of ["Inline", "Editor", "GroupEditor", "Members"]) {
    install()
    start(name, () => {
      globalThis.proof.state.snapshot = { ...globalThis.proof.state.snapshot, dataEpoch: "after" }
    })
    await flush()
    assert.equal(
      calls.filter((call) => typeof call === "object").length,
      0,
      `${name} rejects a stale handler before real dispatch`
    )
    assert.equal(values.size, 0, `${name} does not write a pending request for a retired handler`)
  }
  console.log(
    JSON.stringify(
      {
        sourceRoot: root,
        mode: "actual component/controller callbacks with deterministic React/storage/API ports; no GUI",
        results
      },
      null,
      2
    )
  )
  assert.equal(
    results.filter((r) => !r.pass).length,
    0,
    "Retired epochs retain exact intents; same-epoch unmount cleans exact known receipts without UI"
  )
} finally {
  await fs.rm(scratch, { recursive: true, force: true })
  delete globalThis.proof
  delete globalThis.localStorage
}
