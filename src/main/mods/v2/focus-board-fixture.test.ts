import { randomUUID } from "node:crypto"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import type {
  FunctionPaneSnapshot,
  FunctionUiAction,
  FunctionUiElement
} from "../../../shared/mods/v2/ui"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const fixtureRoot = resolve("tests/fixtures/mods-v2/focus-board")
const sessions: FunctionSession[] = []
const temporary: string[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
  for (const directory of temporary.splice(0)) {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("mods-focus-fixture-")
    )
      throw Error("Unexpected focus fixture cleanup path")
    await rm(directory, { recursive: true, force: true })
  }
})

async function openFixture(root = fixtureRoot, captureRenderError = false) {
  const compiled = await compileFunctionPlugin(root)
  const diagnostics = captureRenderError
    ? `
    const original=__cmbFunctionMod.register;
    __cmbFunctionMod={register(on,options){return original((...args)=>{
      const binding=on(...args);
      if(args[0]==="ui.render")binding.catch(($,e,next)=>$.ui.resolve(e).Text({children:"DRAW_REJECTED:"+next.error.message}));
      return binding;
    },options)}};
  `
    : ""
  const guest = await FunctionGuestRuntime.create(compiled.code + diagnostics)
  const session = new FunctionSession(
    [
      {
        name: compiled.name,
        root: compiled.root,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/fixture-project",
      threadId: "fixture-thread",
      assertLive: () => undefined,
      publish: async (value) => value
    }
  )
  sessions.push(session)
  expect(await session.run("focus-board", "")).toEqual({ text: "FOCUS_BOARD_OPEN" })
  return session
}

function controls(tree: FunctionUiElement): FunctionUiElement[] {
  return [
    tree,
    ...(tree.children ?? []).flatMap((child) => (typeof child === "string" ? [] : controls(child)))
  ]
}
function text(tree: FunctionUiElement | string): string {
  return typeof tree === "string" ? tree : (tree.children ?? []).map(text).join("")
}
function action(
  pane: FunctionPaneSnapshot,
  kind: FunctionUiAction["kind"],
  key: string,
  value?: string
): FunctionUiAction {
  const control = controls(pane.tree).find((node) => node.props.key === key)
  expect(control?.press).toBeDefined()
  return {
    pane: pane.key,
    generation: pane.generation,
    intentId: randomUUID(),
    plugin: control!.press!.plugin,
    handle: control!.press!.handle,
    kind,
    ...(value === undefined ? {} : { value })
  }
}

it("loads the actual focus-board package and executes its focus, input and redraw callbacks", async () => {
  const session = await openFixture()
  let [pane] = await session.panes.snapshot()
  expect(
    controls(pane.tree)
      .filter((node) => node.type === "Input")
      .map((node) => node.props.label)
  ).toEqual(["First focus field", "Second focus field"])
  expect(pane.focusRequest?.pending).toBe(true)
  const requestId = pane.focusRequest!.id
  expect(
    await session.panes.act({
      pane: pane.key,
      generation: pane.generation,
      intentId: randomUUID(),
      plugin: pane.plugin,
      handle: 0,
      kind: "focus",
      value: { focused: true, request: requestId }
    })
  ).toEqual({ focused: true, target: { plugin: "focus-board", element: "first" } })
  ;[pane] = await session.panes.snapshot()
  expect(text(pane.tree)).toContain("focus-events:1")
  await session.panes.act(action(pane, "change", "second", "actual input callback"))
  ;[pane] = await session.panes.snapshot()
  expect(text(pane.tree)).toContain("entered:actual input callback")
  await session.panes.act(action(pane, "submit", "second", "actual input callback"))
  await session.panes.act(action(pane, "press", "redraw"))
  ;[pane] = await session.panes.snapshot()
  expect(pane.focusRequest).toEqual({ id: requestId, pending: false })
  expect(text(pane.tree)).toContain("focus-events:1 entered:actual input callback")
  await session.panes.closePane("focus-board", "focus-board")
  expect(await session.panes.snapshot()).toEqual([])
})

it("rejects a temporarily broken focus fixture with missing Input submit handlers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mods-focus-fixture-"))
  temporary.push(directory)
  await cp(fixtureRoot, directory, { recursive: true })
  const sourcePath = join(directory, "hooks", "register.tsx")
  const original = await readFile(sourcePath, "utf8")
  const broken = original.replace(/onSubmit=\{\(\) => \{\}\}/g, "")
  expect(broken).not.toBe(original)
  await writeFile(sourcePath, broken)
  const session = await openFixture(directory, true)
  const [pane] = await session.panes.snapshot()
  expect(controls(pane.tree).some((node) => node.type === "Input")).toBe(false)
  expect(text(pane.tree)).toMatch(/DRAW_REJECTED:.*MODS_UI_CALLBACK/)
})
