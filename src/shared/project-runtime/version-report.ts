import type { HostProjectState } from "./host-types"
import type { ProjectRuntimeManifest } from "./types"

export interface ProjectVersionReport {
  retainedVersion: string
  installedVersion: string | null
  status: "unavailable" | "unchanged-declaration" | "review-required"
  differences: string[]
  guidance: string
}

/** Declaration compatibility only. Never a migration, code audit, grant or rollback of data. */
export function compareProjectVersions(
  current: HostProjectState,
  installed: ProjectRuntimeManifest | undefined
): ProjectVersionReport {
  const guidance =
    "当前任务继续使用原模板副本。试用另一版本时，请在新目录创建任务；如需回退，在插件管理中安装原版本包。回退代码不会撤销已写入的文件或外部操作。"
  if (!installed || installed.plugin.id !== current.packageId || installed.mode !== "host")
    return {
      retainedVersion: current.packageVersion,
      installedVersion: installed?.plugin.version ?? null,
      status: "unavailable",
      differences: ["未找到同一插件的可用项目模板。"],
      guidance
    }
  const differences: string[] = []
  if (installed.plugin.version !== current.packageVersion)
    differences.push("已安装版本与本任务保留的版本不同。")
  const fields = [
    ["stages", "阶段顺序、技能或人工确认设置发生变化，不能沿用原阶段进度。"],
    ["artifacts", "成果文件或必需项发生变化，请先核对原文件。"],
    ["checks", "检查规则发生变化，原检查通过记录不能代替新版检查。"],
    ["actions", "依赖插件或动作版本发生变化，需要重新核对与授权。"],
    ["environment", "运行环境要求发生变化。"],
    ["capabilities", "模板声明的运行能力发生变化，仍以宿主实际支持为准。"]
  ] as const
  for (const [key, label] of fields)
    if (JSON.stringify(current.manifest[key]) !== JSON.stringify(installed[key]))
      differences.push(label)
  if (!differences.length)
    differences.push("已安装模板的配置声明相同；此检查不代表源码、依赖或成果内容相同。")
  return {
    retainedVersion: current.packageVersion,
    installedVersion: installed.plugin.version,
    status:
      differences.length === 1 && differences[0].startsWith("已安装模板的配置")
        ? "unchanged-declaration"
        : "review-required",
    differences,
    guidance
  }
}
