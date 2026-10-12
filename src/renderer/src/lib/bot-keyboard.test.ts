import { expect, it, vi } from "vitest"
import { botShortcutActions, resolveBotWorkspaceShortcut } from "./bot-keyboard"
import { resolveAdjacentAgentId } from "../components/bots/upstream/grok-keyboard-shortcuts"

function fixture() {
  const handlers = {
    newBot: vi.fn(),
    jump: vi.fn(),
    settings: vi.fn(),
    focusInput: vi.fn(),
    search: vi.fn(),
    find: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    tools: vi.fn(),
    sidebar: vi.fn(),
    previous: vi.fn(),
    next: vi.fn(),
    focus: vi.fn()
  }
  const actions = botShortcutActions(handlers)
  const event = {
    key: "f",
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault: vi.fn()
  }
  return { actions, event, handlers }
}
it("preserves IME, already-handled keys, native controls and unrelated modifier chords", () => {
  const f = fixture()
  expect(resolveBotWorkspaceShortcut(f.event, f.actions)?.id).toBe("find")
  for (const extra of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { defaultPrevented: true },
    { altKey: true }
  ])
    expect(resolveBotWorkspaceShortcut({ ...f.event, ...extra }, f.actions)).toBeNull()
  expect(
    resolveBotWorkspaceShortcut({ ...f.event, ctrlKey: false, metaKey: true }, f.actions)?.id
  ).toBe("find")
})
it("keeps computer, dialogs and menus outside the workspace's shortcut ownership", () => {
  const f = fixture()
  const target = { closest: vi.fn(() => ({})) } as unknown as EventTarget
  expect(resolveBotWorkspaceShortcut({ ...f.event, target }, f.actions)).toBeNull()
  expect(f.handlers.find).not.toHaveBeenCalled()
})
it("does not steal input editing keys but permits explicit search and conversation selection", () => {
  const f = fixture()
  const target = { tagName: "TEXTAREA" } as unknown as EventTarget
  expect(resolveBotWorkspaceShortcut({ ...f.event, key: "i", target }, f.actions)).toBeNull()
  expect(resolveBotWorkspaceShortcut({ ...f.event, target }, f.actions)?.id).toBe("find")
  resolveBotWorkspaceShortcut({ ...f.event, key: "3", target }, f.actions)?.run()
  expect(f.handlers.focus).toHaveBeenCalledWith(2)
  expect(resolveAdjacentAgentId(["a", "b"], "a", "previous")).toBeNull()
  expect(resolveAdjacentAgentId(["a", "b"], "a", "next")).toBe("b")
  expect(resolveAdjacentAgentId(["a", "b"], "missing", "next")).toBeNull()
  resolveBotWorkspaceShortcut({ ...f.event, key: "[", target }, f.actions)?.run()
  resolveBotWorkspaceShortcut({ ...f.event, key: "]", target }, f.actions)?.run()
  expect(f.handlers.back).toHaveBeenCalledOnce()
  expect(f.handlers.forward).toHaveBeenCalledOnce()
  resolveBotWorkspaceShortcut({ ...f.event, key: "b", target }, f.actions)?.run()
  resolveBotWorkspaceShortcut({ ...f.event, key: "m", shiftKey: true, target }, f.actions)?.run()
  expect(f.handlers.sidebar).toHaveBeenCalledOnce()
  expect(f.handlers.tools).toHaveBeenCalledOnce()
})

it("allows the existing focus action from local details while keeping the computer tab private", () => {
  const f = fixture()
  const panel = { className: "bot-computer-panel bot-inspector-panel", tab: "details" }
  // closest is the DOM boundary; the real Workspace owning case verifies this
  // distinction using the shared panel and native browser selectors.
  const target = {
    tagName: "BUTTON",
    closest: vi.fn((selector: string) => {
      const excluded = selector.split(",")
      return excluded.some(
        (rule) =>
          rule === ".bot-computer-panel" || rule === `.bot-computer-panel[data-tab="${panel.tab}"]`
      )
        ? panel
        : null
    })
  } as unknown as EventTarget
  const event = { ...f.event, key: "i", target }
  for (const tab of ["details", "library", "members"]) {
    panel.tab = tab
    const action = resolveBotWorkspaceShortcut(event, f.actions)
    expect(action?.id).toBe("focusInput")
    action?.run()
  }
  expect(f.handlers.focusInput).toHaveBeenCalledTimes(3)
  panel.tab = "computer"
  expect(resolveBotWorkspaceShortcut(event, f.actions)).toBeNull()
  expect(f.handlers.focusInput).toHaveBeenCalledTimes(3)
})
it("keeps editable local fields and independent modal owners outside the focus action", () => {
  const f = fixture()
  const editable = {
    tagName: "DIV",
    isContentEditable: true,
    closest: vi.fn(() => null)
  } as unknown as EventTarget
  expect(
    resolveBotWorkspaceShortcut({ ...f.event, key: "i", target: editable }, f.actions)
  ).toBeNull()
  for (const role of ["dialog", "alertdialog", "menu", "listbox", "application"]) {
    const target = {
      tagName: "BUTTON",
      closest: vi.fn((selector: string) =>
        selector.split(",").includes(`[role="${role}"]`) ? {} : null
      )
    } as unknown as EventTarget
    expect(resolveBotWorkspaceShortcut({ ...f.event, key: "i", target }, f.actions)).toBeNull()
  }
  expect(f.handlers.focusInput).not.toHaveBeenCalled()
})

it("routes the original new-chat shortcut to its injected chooser action", () => {
  const f = fixture()
  const action = resolveBotWorkspaceShortcut({ ...f.event, key: "n" }, f.actions)
  expect(action?.id).toBe("newBot")
  expect(action?.label).toBe("新建聊天")
  action?.run()
  expect(f.handlers.newBot).toHaveBeenCalledOnce()
  expect(f.handlers.jump).not.toHaveBeenCalled()
})
