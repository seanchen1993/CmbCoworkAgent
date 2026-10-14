import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import type { CommunityExample, CommunityExampleId } from "../../shared/mods/community-examples"
import { bundledModExamplesRoot } from "./bundled-examples"

const commit = "569c5283d9a0a7ee7938df85bb32e4f48cbb8c86"
const repository = "https://github.com/anthropics/claude-code-playground"
const provenanceHash = "d8c4b45497f61d9873355e633bbcedec3c5637f657a5db882e0b0fc0c271e00b"
const conflictNote = "用量天气会接管输入框上方区域，可能遮住修改回放的入口；建议分开应用。"

export const COMMUNITY_EXAMPLES: readonly CommunityExample[] = [
  {
    id: "token-weather",
    pluginName: "token-weather",
    title: "用量天气",
    description: "在输入框上方用天气图标展示会话用量趋势。",
    usage: "安装后在当前对话授权并应用，发送一轮聊天即可看到用量变化。",
    conflictNote,
    upstreamUrl: `${repository}/tree/${commit}/claude-code/mods/token-weather`,
    commit
  },
  {
    id: "replay-theater",
    pluginName: "replay-theater",
    title: "修改回放",
    description: "执行文件编辑后打开回放面板，查看实际修改前后的差异。",
    usage: "安装、授权并应用后，让助手编辑工作区文件，再打开修改回放查看差异。",
    conflictNote,
    upstreamUrl: `${repository}/tree/${commit}/claude-code/mods/replay-theater`,
    commit
  },
  {
    id: "blast-radius",
    pluginName: "blast-radius",
    title: "危险命令确认",
    description: "拦下匹配的危险命令，展示影响范围，由你继续或取消；不替代原有权限审批。",
    usage: "安装、授权并应用后，匹配的危险命令会先显示确认面板，可选择取消。",
    upstreamUrl: `${repository}/tree/${commit}/claude-code/mods/blast-radius`,
    commit
  }
]

export function communityExampleId(value: unknown): CommunityExampleId {
  if (!COMMUNITY_EXAMPLES.some((example) => example.id === value))
    throw Error("MODS_COMMUNITY_EXAMPLE_INVALID")
  return value as CommunityExampleId
}

export function bundledCommunityExamplesRoot(mainDirectory: string): string {
  return join(bundledModExamplesRoot(mainDirectory), "community-originals")
}

type OriginalFile = { fixturePath: string; bytes: number; sha256: string }
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

async function regularFile(path: string): Promise<Buffer> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("MODS_COMMUNITY_INTEGRITY")
  return readFile(path)
}

async function treeFiles(root: string, prefix = ""): Promise<string[]> {
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("MODS_COMMUNITY_INTEGRITY")
  const files: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error("MODS_COMMUNITY_INTEGRITY")
    const name = `${prefix}${entry.name}`
    if (entry.isDirectory()) files.push(...(await treeFiles(join(root, entry.name), `${name}/`)))
    else if (entry.isFile()) files.push(name)
    else throw Error("MODS_COMMUNITY_INTEGRITY")
  }
  return files.sort()
}

/** Only the shipped, pinned provenance can select files; renderer input never supplies paths. */
export async function verifyCommunityExample(
  root: string,
  id: CommunityExampleId,
  installedDirectory?: string
): Promise<string> {
  communityExampleId(id)
  const provenanceBytes = await regularFile(join(root, "provenance.json"))
  if (sha(provenanceBytes) !== provenanceHash) throw Error("MODS_COMMUNITY_INTEGRITY")
  const provenance = JSON.parse(provenanceBytes.toString("utf8")) as {
    repository: string
    commit: string
    files: OriginalFile[]
  }
  if (provenance.commit !== commit || provenance.repository !== repository)
    throw Error("MODS_COMMUNITY_INTEGRITY")
  const license = provenance.files.find((file) => file.fixturePath === "LICENSE")!
  const licenseBytes = await regularFile(join(root, "LICENSE"))
  if (licenseBytes.length !== license.bytes || sha(licenseBytes) !== license.sha256)
    throw Error("MODS_COMMUNITY_INTEGRITY")
  const directory = installedDirectory ?? join(root, id)
  const files = provenance.files.filter((file) => file.fixturePath.startsWith(`${id}/`))
  const names = files.map((file) => file.fixturePath.slice(id.length + 1)).sort()
  if (files.length !== 3 || JSON.stringify(await treeFiles(directory)) !== JSON.stringify(names))
    throw Error("MODS_COMMUNITY_INTEGRITY")
  for (const file of files) {
    const bytes = await regularFile(join(directory, file.fixturePath.slice(id.length + 1)))
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256)
      throw Error("MODS_COMMUNITY_INTEGRITY")
  }
  return directory
}
