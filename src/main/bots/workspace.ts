import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { BotError } from "../../shared/bots/contracts"
import type { BotWorkWorkspacePort } from "../../shared/bots/work"
import { parseBotWorkWorkspace } from "../../shared/bots/validation"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { validateWorkspaceDirectory } from "../services/workspace-validation"
import { botDirectory } from "./paths"
import type { HarnessProjectListItem } from "../../shared/harness-board-types"

/** beta stores the parent workspace and its project folder separately. */
function projectDirectory(project: HarnessProjectListItem): string {
  const folder = project.projectDir.trim() || project.projectCode.trim()
  const parent = project.workspacePath
  const path = resolve(parent, folder)
  const part = relative(parent, path)
  if (
    !isAbsolute(parent) ||
    !part ||
    part.startsWith("..") ||
    isAbsolute(part) ||
    basename(path) !== folder
  )
    throw new BotError("INVALID_INPUT", "项目登记目录无效，请检查项目配置")
  return path
}

// Reuse beta's bounded, worker-backed local catalog. No enterprise/IM request,
// directory scan, feature initialization, or project-mode run is performed.
async function catalog(input: { query?: string; projectId?: string; projectCursor?: number }) {
  const { readHarnessCatalogPageInWorker } = await import("../harness-board/catalog-client")
  return readHarnessCatalogPageInWorker(
    { ...input, includeRegistry: false, projectLimit: 20 },
    `bot-work-workspace:${randomUUID()}`
  )
}

export const localBotWorkspaces: BotWorkWorkspacePort = {
  async resolve(botId, request) {
    if (!request)
      return {
        kind: "default",
        path: botDirectory(join(getCmbCoworkAgentDataRoot(), "bots"), "workspaces", botId)
      }
    const target = parseBotWorkWorkspace(request)
    if (target.kind === "directory") {
      const path = target.path.startsWith("~/")
        ? join(homedir(), target.path.slice(2))
        : target.path
      return { kind: "directory", path: await validateWorkspaceDirectory(path) }
    }
    const page = await catalog({ projectId: target.projectId })
    const project = page.projects.find((p) => p.projectId === target.projectId)
    if (!project || project.lifecycle.status === "archived")
      throw new BotError("INVALID_INPUT", "项目不存在或已归档，请明确一个可用项目或目录")
    return {
      kind: "project",
      projectId: project.projectId,
      projectName: project.name,
      path: await validateWorkspaceDirectory(projectDirectory(project))
    }
  },
  async projects(query, cursor) {
    if (
      !query.trim() ||
      query.length > 160 ||
      (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
    )
      throw new BotError("INVALID_INPUT", "请提供项目名称，或有效的项目分页游标")
    const page = await catalog({ query, projectCursor: cursor })
    return {
      items: page.projects.map((p) => ({
        projectId: p.projectId,
        name: p.name,
        path: projectDirectory(p),
        archived: p.lifecycle.status === "archived"
      })),
      nextCursor: page.projectNextCursor
    }
  }
}
