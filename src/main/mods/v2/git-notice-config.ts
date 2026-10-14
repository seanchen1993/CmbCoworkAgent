import type { FunctionConfigHandle } from "./config-row-registry"

/** One application setting, even when multiple projects expose it to their own components. */
export function gitNoticeFunctionConfig(
  read: () => { value: boolean; revision: string },
  write: (value: boolean) => boolean,
  changed: (current: { value: boolean; revision: string }) => void
): FunctionConfigHandle {
  return {
    key: "gitChangeNoticeEnabled",
    storageKey: "application:gitChangeNoticeEnabled",
    label: "Git 变更提示",
    description: "在聊天中显示任务产生的代码变更提示。",
    kind: "boolean",
    provider: { plugin: "engine", tier: "core" },
    locked: () => false,
    validate: (value) => typeof value === "boolean",
    cell: {
      read,
      write: (value) => {
        if (typeof value !== "boolean") throw new Error("Invalid Git change notice setting")
        write(value)
        changed(read())
      }
    }
  }
}
