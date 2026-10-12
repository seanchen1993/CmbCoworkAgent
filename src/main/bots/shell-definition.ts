import { relative } from "node:path"
import { BotProjectFiles } from "./project-files"
import { parseBotShellReviewCandidate } from "./shell-review-candidate"
import type { BotShellDefinition } from "../../shared/bot-shell-definition"

/** Grok's candidate discovery with Cmb's stable, project-bounded reads. The
 * definition is package.json or the entry script, not the dependency tree. */
export async function botShellDefinition(
  project: BotProjectFiles,
  command: string
): Promise<BotShellDefinition | undefined> {
  const candidate = parseBotShellReviewCandidate(command, project.root)
  if (!candidate) return undefined
  const absolute = candidate.kind === "executable" ? candidate.path : candidate.packageJsonPath
  const path = absolute ? relative(project.root, absolute) : "package.json"
  const unavailable: BotShellDefinition = { kind: "unavailable", path }
  // Project selection flags can make the command use another manifest. Do not
  // bind it to the root manifest merely because the upstream parser found one.
  const options = command.split(/\s--\s/, 1)[0]
  if (
    candidate.kind === "package_script_unresolved" ||
    /(?:^|\s)(?:--(?:prefix|cwd|dir|workspace|workspaces|filter|global)(?:=|\s|$)|-[CwFg])/.test(
      options
    )
  )
    return unavailable
  try {
    const file = await project.read(path)
    const definition: unknown =
      candidate.kind === "executable"
        ? file.text
        : JSON.parse(file.text)?.scripts?.[candidate.scriptName]
    if (typeof definition !== "string" || definition.length > 8000) return unavailable
    return { kind: candidate.kind, path, sha256: file.sha256, definition }
  } catch {
    return unavailable
  }
}

export async function assertBotShellDefinition(
  project: BotProjectFiles,
  definition?: BotShellDefinition
): Promise<void> {
  if (!definition || definition.kind === "unavailable") return
  const current = await project.read(definition.path)
  if (current.sha256 !== definition.sha256)
    throw new Error("命令的脚本定义在审批后已变化，请重新读取并发起操作")
}
