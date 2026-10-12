import {
  resolveGlobalShortcutAction,
  type GlobalShortcutAction,
  type KeyboardShortcutEvent
} from "../components/bots/upstream/grok-keyboard-shortcuts"

export function botShortcutActions(handlers: {
  newBot(): void
  jump(): void
  settings?(): void
  focusInput?(): void
  selectionQuote?(): void
  search?(): void
  find?(): void
  back?(): void
  forward?(): void
  tools?(): void
  sidebar?(): void
  previous(): void
  next(): void
  focus(index: number): void
}): GlobalShortcutAction[] {
  const actions: GlobalShortcutAction[] = [
    {
      id: "newBot",
      label: "新建聊天",
      hotkey: "mod+n",
      isEnabledInContentEditable: true,
      run: handlers.newBot
    },
    {
      id: "jump",
      label: "快速查找与操作",
      hotkey: "mod+k",
      isEnabledInContentEditable: true,
      run: handlers.jump
    },
    {
      id: "previous",
      label: "上一个会话",
      hotkey: "alt+up",
      isEnabledInContentEditable: true,
      run: handlers.previous
    },
    {
      id: "next",
      label: "下一个会话",
      hotkey: "alt+down",
      isEnabledInContentEditable: true,
      run: handlers.next
    },
    ...Array.from(
      { length: 9 },
      (_, offset): GlobalShortcutAction => ({
        id: `focus${offset + 1}` as GlobalShortcutAction["id"],
        label: `切换到第 ${offset + 1} 个会话`,
        hotkey: `mod+${offset + 1}`,
        isEnabledInContentEditable: true,
        run: () => handlers.focus(offset)
      })
    )
  ]
  if (handlers.settings)
    actions.push({
      id: "settings",
      label: "当前 Bot 或群聊设置",
      hotkey: "mod+comma",
      isEnabledInContentEditable: true,
      run: handlers.settings
    })
  for (const [id, hotkey, label] of [
    ["back", "mod+bracketleft", "返回上个访问的会话"],
    ["forward", "mod+bracketright", "前进到下个访问的会话"],
    ["tools", "mod+shift+m", "管理当前 Bot 技能"],
    ["sidebar", "mod+b", "切换紧凑侧栏"]
  ] as const) {
    const run = handlers[id]
    if (run) actions.push({ id, hotkey, label, isEnabledInContentEditable: true, run })
  }
  if (handlers.focusInput)
    actions.push({
      id: "focusInput",
      label: "聚焦输入框",
      hotkey: "mod+i",
      run: handlers.focusInput
    })
  if (handlers.selectionQuote)
    actions.push({
      id: "selectionQuote",
      label: "引用选中文字",
      hotkey: "mod+l",
      run: handlers.selectionQuote
    })
  if (handlers.search)
    actions.push({
      id: "search",
      label: "搜索工作区",
      hotkey: "mod+shift+f",
      isEnabledInContentEditable: true,
      run: handlers.search
    })
  if (handlers.find)
    actions.push({
      id: "find",
      label: "查找当前会话",
      hotkey: "mod+f",
      isEnabledInContentEditable: true,
      run: handlers.find
    })
  return actions
}

export function resolveBotWorkspaceShortcut(
  event: KeyboardShortcutEvent & {
    isComposing?: boolean
    keyCode?: number
    repeat?: boolean
  },
  actions: readonly GlobalShortcutAction[]
): GlobalShortcutAction | null {
  if (event.isComposing || event.keyCode === 229 || event.key === "Process" || event.repeat)
    return null
  const target = event.target as { closest?: (selector: string) => unknown } | null
  if (
    target?.closest?.(
      '.bot-computer-panel[data-tab="computer"],[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="application"]'
    )
  )
    return null
  return resolveGlobalShortcutAction(event, actions)
}

export function botShortcutLabel(hotkey: string, mac: boolean): string {
  const names: Record<string, string> = {
    mod: mac ? "⌘" : "Ctrl",
    alt: mac ? "⌥" : "Alt",
    shift: "Shift",
    up: "↑",
    down: "↓",
    comma: ",",
    bracketleft: "[",
    bracketright: "]"
  }
  return hotkey
    .split(", ")
    .map((chord) =>
      chord
        .split("+")
        .map((key) => names[key] ?? key.toUpperCase())
        .join(" + ")
    )
    .join(" / ")
}
