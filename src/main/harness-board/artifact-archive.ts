import { cp, lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"
import type { HarnessDeployUnitMapping } from "../../shared/harness-board-types"
import { writeHarnessJsonFileAtomic } from "./async-json-store"

const ARCHIVE_INPUT_FILE = "archive-input.json"

interface ArchiveInput {
  artifactPaths: string[]
  knowledgeWritePath: string
  projectCode: string
  projectName: string
  sapId: string
  feature: string
  selectedDeployUnits: HarnessDeployUnitMapping[]
}

function archiveName(value: string, label: string): string {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.toLowerCase() === ".git" ||
    /[<>:"/\\|?*]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)
  ) {
    throw new Error(`${label}不能作为目录或文件名：${value}`)
  }
  return value
}

async function statIfPresent(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

async function checkMetadataPath(path: string): Promise<boolean> {
  const info = await statIfPresent(path)
  if (info && !info.isFile()) throw new Error(`归档记录路径必须是普通文件：${path}`)
  return info !== null
}

async function readHistory(path: string): Promise<Array<Record<string, unknown>>> {
  if (!(await checkMetadataPath(path))) return []
  const records: unknown = JSON.parse(await readFile(path, "utf8"))
  if (
    !Array.isArray(records) ||
    records.some((record) => !record || typeof record !== "object" || Array.isArray(record))
  ) {
    throw new Error(`归档记录必须是对象数组：${path}`)
  }
  return records
}

async function checkTargetDirectory(path: string): Promise<void> {
  const info = await statIfPresent(path)
  if (info?.isSymbolicLink()) throw new Error(`目标目录含有链接：${path}`)
  if (info && !info.isDirectory()) throw new Error(`目标目录已被文件占用：${path}`)
}

async function checkArtifact(path: string): Promise<boolean> {
  archiveName(basename(path), "产物名称")
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new Error(`产物包含链接：${path}`)
  if (!info.isFile() && !info.isDirectory()) throw new Error(`无法复制产物：${path}`)
  return info.isDirectory()
}

async function appendAgents(path: string, content: string): Promise<void> {
  const handle = await open(path, "a+")
  try {
    const { size } = await handle.stat()
    let prefix = ""
    if (size > 0) {
      const lastByte = Buffer.alloc(1)
      await handle.read(lastByte, 0, 1, size - 1)
      if (lastByte[0] !== 10) prefix = "\n"
    }
    await handle.appendFile(prefix + content, "utf8")
  } finally {
    await handle.close()
  }
}

export async function archiveArtifactsInternally(input: ArchiveInput): Promise<void> {
  const { projectCode, projectName, sapId, feature } = input
  if (!projectCode.trim() || !projectName.trim() || !sapId.trim()) {
    throw new Error("项目编号、项目名称和 sapId 均不能为空")
  }
  const project = archiveName(`${projectCode}_${projectName}_${sapId}`, "归档项目目录名")
  archiveName(feature, "特性标识")
  const root = await realpath(input.knowledgeWritePath)
  if (!(await stat(root)).isDirectory()) throw new Error(`知识库写入路径不是目录：${root}`)
  const historyPath = join(root, ARCHIVE_INPUT_FILE)
  const history = await readHistory(historyPath)
  if (
    history.some(
      (record) =>
        record.projectName === projectName && record.sapId === sapId && record.feature === feature
    )
  ) {
    throw new Error(`该特性已归档：${projectCode}/${feature}`)
  }

  const sources: Array<{ path: string; name: string; directory: boolean }> = []
  for (const path of input.artifactPaths) {
    sources.push({ path, name: basename(path), directory: await checkArtifact(path) })
  }
  const units = input.selectedDeployUnits.length
    ? input.selectedDeployUnits.map((unit) => unit.deployUnitId)
    : ["common"]
  const targets: Array<{ folder: string; agentsPath: string }> = []
  const seenPaths = new Set<string>()
  for (const unit of units) {
    archiveName(unit, "发布单元 ID")
    if (unit.toLowerCase() === ARCHIVE_INPUT_FILE) {
      throw new Error(`发布单元 ID 与归档记录文件名冲突：${unit}`)
    }
    const unitDirectory = join(root, unit)
    const projectDirectory = join(unitDirectory, project)
    const folder = join(projectDirectory, feature)
    const agentsPath = join(unitDirectory, "Agents.md")
    await checkTargetDirectory(unitDirectory)
    await checkTargetDirectory(projectDirectory)
    if (await statIfPresent(folder)) {
      throw new Error(`该特性已归档或归档目录已被占用：${folder}`)
    }
    await checkMetadataPath(agentsPath)
    for (const source of sources) {
      const target = join(folder, source.name)
      const key = target.toLowerCase()
      if (seenPaths.has(key)) throw new Error(`归档目标同名冲突：${target}`)
      seenPaths.add(key)
      const rel = relative(source.path, target)
      if (source.directory && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) {
        throw new Error(`不能将目录产物复制到其自身内部：${target}`)
      }
    }
    targets.push({ folder, agentsPath })
  }

  const createdFolders: string[] = []
  try {
    for (const { folder } of targets) {
      await mkdir(dirname(folder), { recursive: true })
      await mkdir(folder)
      createdFolders.push(folder)
      for (const source of sources) {
        await cp(source.path, join(folder, source.name), {
          recursive: source.directory,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true,
          filter: async (path) => {
            await checkArtifact(path)
            return true
          }
        })
      }
    }
  } catch (error) {
    await Promise.allSettled(createdFolders.map((folder) => rm(folder, { recursive: true })))
    throw error
  }

  for (const { folder, agentsPath } of targets) {
    const entries = sources
      .map(({ name }) => {
        const path = relative(root, join(folder, name)).split(sep).join("/")
        return `- ${path}: ${projectName}_的文档\n`
      })
      .join("")
    await appendAgents(agentsPath, entries)
  }
  await writeHarnessJsonFileAtomic(
    historyPath,
    [...history, input],
    Number.MAX_SAFE_INTEGER,
    "归档记录"
  )
}
