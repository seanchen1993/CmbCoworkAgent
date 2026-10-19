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

/** Local packages have their own provenance; none is presented as an upstream original. */
export const PLATFORM_EXAMPLES: readonly CommunityExample[] = [
  {
    id: "task-workbench-provider",
    pluginName: "task-workbench-provider",
    title: "任务能力提供方",
    description: "把获准的本地进程发布为独立能力，供另一个灵件读取状态、启动或取消。",
    usage:
      "第 1 步：在当前聊天核对并使用本提供方；再添加“个人任务工作台”。本项没有独立页面，发现能力不会执行命令。",
    origin: "devclaw",
    sourcePath: "examples/sparks-task-workbench/provider",
    version: "1.0.0"
  },
  {
    id: "task-workbench-consumer",
    pluginName: "task-workbench-consumer",
    title: "个人任务工作台",
    description: "独立界面包通过公开协议组合任务能力，展示真实任务状态、输出和取消结果。",
    usage:
      "第 2 步：先在同一聊天使用“任务能力提供方”，再使用本项。从扩展页面打开“个人任务工作台”，点击“启动实际任务”，核对原生进程审批和真实输出。默认需要可用的 node。",
    origin: "devclaw",
    sourcePath: "examples/sparks-task-workbench/consumer",
    version: "1.0.0"
  },
  {
    id: "task-behavior-prefix",
    pluginName: "task-behavior-prefix",
    title: "前缀提醒",
    description: "在真实通知和输入建议前添加提醒前缀，保留宿主原有显示与审批链。",
    usage:
      "使用后到“行为设置”预览；每个处理点选择一个替代实现并确认应用，再用工作台“核对通知样式”或“核对输入建议”验证。停用该行为后恢复原生呈现。",
    conflictNote:
      "与“精简提醒”替代相同的通知和输入建议处理点；需要在行为设置选择，不能同时接管同一个点。",
    origin: "devclaw",
    sourcePath: "examples/sparks-task-workbench/behavior-prefix",
    version: "1.0.0"
  },
  {
    id: "task-behavior-compact",
    pluginName: "task-behavior-compact",
    title: "精简提醒",
    description: "精简真实通知和输入建议文本，可与另一作者的替代实现对比、选择和恢复。",
    usage:
      "使用后到“行为设置”预览与“前缀提醒”的冲突；每个处理点选择一个实现并确认，再用工作台按钮核对。停用该行为后恢复原生呈现。",
    conflictNote:
      "与“前缀提醒”替代相同处理点。加入当前聊天不等于已选择替代行为，需另行预览并确认。",
    origin: "devclaw",
    sourcePath: "examples/sparks-task-workbench/behavior-compact",
    version: "1.0.0"
  },
  {
    id: "edit-reminder",
    pluginName: "edit-reminder",
    title: "编辑提醒",
    description: "订阅宿主真实文件编辑完成事件，在独立侧栏核对已成功的文件变更。",
    usage:
      "使用后打开扩展页面中的“编辑提醒”。点击“明确写入示例文件”并完成原生文件审批，核对真实文件和完成记录。默认文件 edit-reminder.txt 只创建一次；再次演示请换新工作目录。",
    origin: "devclaw",
    sourcePath: "examples/sparks-edit-reminder",
    version: "1.0.0"
  }
]

export const BUNDLED_EXAMPLES: readonly CommunityExample[] = [
  ...PLATFORM_EXAMPLES,
  ...COMMUNITY_EXAMPLES
]

// Fixed executable bytes from the canonical directories copied by the build resource mirror.
const platformFiles: Record<string, Record<string, string>> = {
  "task-workbench-provider": {
    "hooks/hooks.json": "1c3cfc433b9383b0f6d714b7599d81bbc585d104ae2dffe321a190d81010ce5b",
    "hooks/register.ts": "e5e8f877bde33aef2d41029dac9b0ff7b677a7e85c39deb114649c1fc2f89e0a",
    "plugin.json": "5390bbb0ec5e5c385920ab1ac30e6962bb8996a82f4d9b1679284ab919440e99",
    "README.md": "2f0f62e62089701e1e2b9c93578748266dee719a6ffbdb984f0f8ddaa5ca8267"
  },
  "task-workbench-consumer": {
    "hooks/hooks.json": "4430bf8c3fc36d2d74bf3144a7c1e09e359b351169bab16a3cf7f6e9366abc43",
    "hooks/register.ts": "63810666e52efaf575bf830c36eaa568ca4c60bcd6da6a679302d1795a8e9e72",
    "plugin.json": "88a3bb8ef3c85b91a02a901b8c2443864ac570abb7e4aab1457becd5c4b88a51",
    "README.md": "f55638b133999415da809bc3c83365fe0e0d752dd33295d8ef90071533c6da72"
  },
  "task-behavior-prefix": {
    "hooks/hooks.json": "c835c92d8e1159d20a40ca78ad654da7433942c3694ffeda0b376b0c4dfd52cf",
    "hooks/register.ts": "865b0e22314c479b8b460387613482488ad2ad3aaf90f904d06b58dc3c99a0e2",
    "plugin.json": "2d744db3c2e9f78b5153c95262acc333b0c237bd01e6eae94e04dedc66e0de13"
  },
  "task-behavior-compact": {
    "hooks/hooks.json": "c835c92d8e1159d20a40ca78ad654da7433942c3694ffeda0b376b0c4dfd52cf",
    "hooks/register.ts": "522edc4053e6209872f2eedda318a2fd7acda31a323f5ce1f2d593a811bbc45b",
    "plugin.json": "c4aec446f5c92269f970828c6f4504a4a39a49fedd9963ef40a22f55c2fb6f04"
  },
  "edit-reminder": {
    "hooks/hooks.json": "1c3cfc433b9383b0f6d714b7599d81bbc585d104ae2dffe321a190d81010ce5b",
    "hooks/register.ts": "102c45d749aadaa2d9466041e13852d868f128f47cc35d3f9bb0526910ec37ed",
    "plugin.json": "9fb57ceeda85472a16b0b774fd132c9548933da710a397fa92fafeb974fedb04",
    "README.md": "424bf6e3799f9d274d29a3627f01d64ec5be8267aad83e68dc8e2785f9c21650"
  }
}

export function communityExampleId(value: unknown): CommunityExampleId {
  if (!BUNDLED_EXAMPLES.some((example) => example.id === value))
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
  if (Object.hasOwn(platformFiles, id)) {
    const localRoot = join(root, "../platform-examples")
    const rootStat = await lstat(localRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw Error("MODS_COMMUNITY_INTEGRITY")
    const directory = installedDirectory ?? join(localRoot, id)
    const expected = platformFiles[id]
    if (JSON.stringify(await treeFiles(directory)) !== JSON.stringify(Object.keys(expected).sort()))
      throw Error("MODS_COMMUNITY_INTEGRITY")
    for (const [name, digest] of Object.entries(expected)) {
      if (sha(await regularFile(join(directory, name))) !== digest)
        throw Error("MODS_COMMUNITY_INTEGRITY")
    }
    return directory
  }
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
