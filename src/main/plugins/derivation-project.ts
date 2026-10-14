import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { isDerivedPlugin } from "./derivation-scope"

/** The original project path is untouched. Derived packages begin in an empty owned project. */
export function assertDerivedProjectDirectory(
  pluginId: string,
  workspace: string,
  projectDir: string
) {
  if (!isDerivedPlugin(pluginId)) return
  const root = resolve(workspace)
  const target = resolve(root, projectDir)
  const local = relative(root, target)
  if (
    !local ||
    local.startsWith("..") ||
    isAbsolute(local) ||
    realpathSync(root).toLowerCase() !== root.toLowerCase()
  )
    throw Error("衍生插件必须使用独立的新项目文件夹")
  if (existsSync(target)) {
    const stat = lstatSync(target)
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      readdirSync(target).length > 0 ||
      realpathSync(target).toLowerCase() !== target.toLowerCase()
    )
      throw Error("衍生插件不能复用已有项目状态，请选择新的空项目文件夹")
  }
  if (existsSync(join(target, ".autobizdevops"))) throw Error("不能复用旧 AutoBiz 状态")
}
