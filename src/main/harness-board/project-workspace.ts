import { constants } from "node:fs"
import { access, readdir, stat } from "node:fs/promises"
import { basename, dirname } from "node:path"

export async function validateProjectDirectorySelection(projectPath: string): Promise<{
  workspacePath: string
  projectDir: string
  validationError: string | null
}> {
  let validationError: string | null = null
  try {
    await assertEmptyProjectDirectory(projectPath)
  } catch (error) {
    validationError = error instanceof Error ? error.message : String(error)
  }
  return { workspacePath: dirname(projectPath), projectDir: basename(projectPath), validationError }
}

export async function assertEmptyProjectDirectory(projectPath: string): Promise<void> {
  let info
  try {
    info = await stat(projectPath)
  } catch {
    throw new Error("项目工作区文件夹不存在或无法访问，请重新选择")
  }
  if (!info.isDirectory()) {
    throw new Error("请选择文件夹作为项目工作区")
  }
  if ((await readdir(projectPath)).length > 0) {
    throw new Error("项目工作区文件夹必须为空，不能包含隐藏文件或文件夹")
  }
  try {
    await access(projectPath, constants.W_OK)
  } catch {
    throw new Error("项目工作区文件夹不可写，请选择其他文件夹")
  }
}
