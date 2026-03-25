/**
 * Skill Evolution Tool
 *
 * Allows the agent to create, view, patch, and list custom skills at runtime.
 * Inspired by Hermes Agent's skill self-improvement loop:
 *   - After 5+ tool calls in a session, the agent is prompted to consider
 *     capturing reusable knowledge as a skill.
 *   - Skills are stored in ~/.cmbcoworkagent/skills/{skill-name}/SKILL.md
 *   - They are automatically loaded by the skills middleware on next session.
 */

import { tool } from "langchain"
import { z } from "zod"
import { join } from "path"
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync
} from "fs"
import { BrowserWindow, ipcMain } from "electron"
import { getCustomSkillsDir, invalidateEnabledSkillsCache } from "../../storage"
import { v4 as uuid } from "uuid"
import type { SkillProposalWindowContext } from "../skill-evolution/proposal-window"

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function notifyRenderer(channel: string, payload?: unknown): void {
  let sentCount = 0
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload)
        sentCount += 1
      }
    } catch {
      // Window may have been destroyed between check and send — ignore
    }
  }
  console.log(`[SkillEvolution] notifyRenderer channel=${channel} windows=${sentCount}`)
}

// ─────────────────────────────────────────────────────────
// Human-confirmation gate for skill creation
//
// Flow:
//   1. Tool calls requestSkillConfirmation() — sends IPC event to renderer
//      with the proposed skill details (name, description, content preview).
//   2. Renderer shows a dialog; user clicks Approve or Reject.
//   3. Renderer calls ipcRenderer.invoke("skill:confirmResponse", { requestId, approved })
//   4. Main process resolves the pending Promise and returns the decision.
// ─────────────────────────────────────────────────────────

export interface SkillConfirmRequest {
  threadId: string
  requestId: string
  skillId: string
  name: string
  description: string
  content: string
}

// ─────────────────────────────────────────────────────────
// Generic pending-response helper
// ─────────────────────────────────────────────────────────

/** Generic map of pending one-shot IPC responses keyed by requestId */
const _pendingResponses = new Map<string, (value: boolean) => void>()

let _responseHandlerRegistered = false
function ensureResponseHandler(): void {
  if (_responseHandlerRegistered) return
  _responseHandlerRegistered = true

  // Handle both intent responses ("yes / no, create skill?") and full confirm responses ("adopt / reject")
  ipcMain.handle("skill:intentResponse", (_event, { requestId, accepted }: { requestId: string; accepted: boolean }) => {
    console.log(`[SkillEvolution] Received intent response: ${requestId} accepted=${accepted}`)
    const resolve = _pendingResponses.get(requestId)
    if (resolve) {
      _pendingResponses.delete(requestId)
      resolve(accepted)
    }
  })

  ipcMain.handle("skill:confirmResponse", (_event, { requestId, approved }: { requestId: string; approved: boolean }) => {
    console.log(`[SkillEvolution] Received confirmation response: ${requestId} approved=${approved}`)
    const resolve = _pendingResponses.get(requestId)
    if (resolve) {
      _pendingResponses.delete(requestId)
      resolve(approved)
    }
  })
}

function waitForResponse(requestId: string, timeoutMs = 5 * 60 * 1000): Promise<boolean> {
  ensureResponseHandler()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _pendingResponses.delete(requestId)
      console.warn(`[SkillEvolution] Response timed out for requestId: ${requestId}`)
      resolve(false)
    }, timeoutMs)

    _pendingResponses.set(requestId, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

// ─────────────────────────────────────────────────────────
// Phase 1 — Intent: "Do you want to save this as a skill?"
// ─────────────────────────────────────────────────────────

export interface SkillIntentRequest {
  threadId: string
  requestId: string
  /** Short summary of what the conversation accomplished */
  summary: string
  /** Number of tool calls made */
  toolCallCount: number
  /** Trigger source for this suggestion */
  mode: "mode_a_rule" | "mode_b_llm"
  /** Optional model recommendation reason for Mode B */
  recommendationReason?: string
  /** Full proposal context — forwarded to renderer so the retry button can replay generation */
  context: SkillProposalWindowContext
}

/**
 * Ask the user (via a lightweight banner) whether they want to create a skill
 * from the current conversation.  Returns true if they click "Yes".
 */
export async function requestSkillIntent(req: SkillIntentRequest): Promise<boolean> {
  const promise = waitForResponse(req.requestId)
  notifyRenderer("skill:intentRequest", req)
  console.log(
    `[SkillEvolution] Sent intent request: ${req.requestId} mode=${req.mode} toolCallCount=${req.toolCallCount}`
  )
  return promise
}

// ─────────────────────────────────────────────────────────
// Phase 2 — Confirmation: show full skill detail for final approval
// ─────────────────────────────────────────────────────────

/**
 * Send a confirmation request to the renderer and wait for the user's decision.
 * Times out after 5 minutes — defaults to rejected.
 *
 * Exported so the auto-trigger path in agent.ts can reuse the same flow.
 */
export async function requestSkillConfirmation(req: SkillConfirmRequest): Promise<boolean> {
  const promise = waitForResponse(req.requestId)
  notifyRenderer("skill:confirmRequest", req)
  console.log(
    `[SkillEvolution] Sent confirmation request: ${req.requestId} for skill "${req.name}" (${req.skillId})`
  )
  return promise
}

/** Sanitize a skill name into a safe directory name */
export function sanitizeSkillId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
}

/** Parse the `name:` field from a SKILL.md frontmatter block */
function parseSkillName(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx > 0 && line.slice(0, colonIdx).trim().toLowerCase() === "name") {
      return line.slice(colonIdx + 1).trim()
    }
  }
  return null
}

/** Parse the `description:` field from a SKILL.md frontmatter block */
function parseSkillDescription(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx > 0 && line.slice(0, colonIdx).trim().toLowerCase() === "description") {
      return line.slice(colonIdx + 1).trim()
    }
  }
  return null
}

interface SkillSummary {
  id: string
  name: string
  description: string
  path: string
  createdAt: string
}

/** List all custom skills in ~/.cmbcoworkagent/skills/ */
function listCustomSkills(): SkillSummary[] {
  const dir = getCustomSkillsDir()
  if (!existsSync(dir)) return []
  const results: SkillSummary[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillMdPath = join(dir, entry.name, "SKILL.md")
    if (!existsSync(skillMdPath)) continue
    const content = readFileSync(skillMdPath, "utf-8")
    results.push({
      id: entry.name,
      name: parseSkillName(content) ?? entry.name,
      description: parseSkillDescription(content) ?? "",
      path: join(dir, entry.name),
      createdAt: entry.name
    })
  }
  return results
}

// ─────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────

const ACTIONS = ["list", "view", "create", "patch", "delete"] as const

const skillEvolveSchema = z.object({
  action: z.enum(ACTIONS).describe(
    "Action: list (show all custom skills) | view (read a skill's SKILL.md) | " +
    "create (write a new skill) | patch (update an existing skill) | delete (remove a skill)"
  ),
  skillId: z.string().optional().describe(
    "Skill directory name (slug). Required for view/patch/delete. " +
    "For create, auto-derived from name if omitted."
  ),
  name: z.string().optional().describe(
    "Human-readable skill name for the SKILL.md frontmatter. Required for create."
  ),
  description: z.string().optional().describe(
    "One-sentence trigger description for the skill (max 200 chars). " +
    "This is the MOST IMPORTANT field — it controls when the agent uses the skill. " +
    "Make it specific: describe the exact situation, not just what it does. " +
    "Required for create."
  ),
  content: z.string().optional().describe(
    "Full SKILL.md content (including YAML frontmatter). Required for create. " +
    "For patch, this is the new content that replaces the current SKILL.md."
  ),
  patchOldString: z.string().optional().describe(
    "For patch action: the exact string to find and replace in the current SKILL.md."
  ),
  patchNewString: z.string().optional().describe(
    "For patch action: the replacement string. Used together with patchOldString."
  )
})

// ─────────────────────────────────────────────────────────
// Tool factory
// ─────────────────────────────────────────────────────────

interface SkillEvolutionToolContext {
  /** The thread that owns this agent run — forwarded into IPC events so the
   *  renderer can filter out events that belong to a different thread. */
  threadId?: string
}

export function createSkillEvolutionTool(context: SkillEvolutionToolContext = {}) {
  return tool(
    async (input) => {
      switch (input.action) {
        // ── list ──────────────────────────────────────────
        case "list": {
          const skills = listCustomSkills()
          if (skills.length === 0) {
            return JSON.stringify({
              skills: [],
              message: "No custom skills yet. Use action='create' to capture reusable knowledge as a skill."
            })
          }
          return JSON.stringify({
            count: skills.length,
            skills: skills.map((s) => ({
              id: s.id,
              name: s.name,
              description: s.description
            }))
          }, null, 2)
        }

        // ── view ──────────────────────────────────────────
        case "view": {
          if (!input.skillId) return "Error: skillId is required for view"
          const skillDir = join(getCustomSkillsDir(), input.skillId)
          if (!existsSync(skillDir)) return `Error: skill not found: ${input.skillId}`
          const skillMdPath = join(skillDir, "SKILL.md")
          if (!existsSync(skillMdPath)) return `Error: SKILL.md not found for: ${input.skillId}`
          const content = readFileSync(skillMdPath, "utf-8")
          return JSON.stringify({
            skillId: input.skillId,
            path: skillMdPath,
            content
          })
        }

        // ── create ────────────────────────────────────────
        case "create": {
          if (!input.name) return "Error: name is required for create"
          if (!input.description) return "Error: description is required for create"
          if (!input.content) return "Error: content is required for create"

          const skillId = input.skillId || sanitizeSkillId(input.name)
          if (!skillId) return "Error: could not derive a valid skill ID from name"

          const customSkillsDir = getCustomSkillsDir()
          const skillDir = join(customSkillsDir, skillId)

          if (existsSync(skillDir)) {
            return `Error: skill already exists: ${skillId}. Use action='patch' to update it.`
          }

          // ── Human confirmation gate ──────────────────────
          const requestId = uuid()
          console.log(`[SkillEvolution] Requesting user confirmation for skill: "${input.name}" (${requestId})`)
          const approved = await requestSkillConfirmation({
            threadId: context.threadId ?? "",
            requestId,
            skillId,
            name: input.name,
            description: input.description,
            content: input.content
          })

          if (!approved) {
            console.log(`[SkillEvolution] User rejected skill creation: "${input.name}"`)
            return JSON.stringify({
              success: false,
              skillId,
              name: input.name,
              message: `User declined to create skill '${input.name}'. No files were written.`
            })
          }
          // ────────────────────────────────────────────────

          mkdirSync(skillDir, { recursive: true })
          writeFileSync(join(skillDir, "SKILL.md"), input.content, "utf-8")

          // Invalidate skills cache so runtime picks up the new skill next invocation
          invalidateEnabledSkillsCache()
          notifyRenderer("skills:changed")

          console.log(`[SkillEvolution] Created skill: ${skillId} at ${skillDir}`)
          return JSON.stringify({
            success: true,
            skillId,
            name: input.name,
            path: skillDir,
            message: `Skill '${input.name}' created successfully. It will be active in the next conversation.`
          })
        }

        // ── patch ─────────────────────────────────────────
        case "patch": {
          if (!input.skillId) return "Error: skillId is required for patch"
          const skillDir = join(getCustomSkillsDir(), input.skillId)
          if (!existsSync(skillDir)) return `Error: skill not found: ${input.skillId}`
          const skillMdPath = join(skillDir, "SKILL.md")

          // Full content replacement
          if (input.content) {
            writeFileSync(skillMdPath, input.content, "utf-8")
            invalidateEnabledSkillsCache()
            notifyRenderer("skills:changed")
            console.log(`[SkillEvolution] Patched (full replace) skill: ${input.skillId}`)
            return JSON.stringify({
              success: true,
              skillId: input.skillId,
              mode: "full_replace",
              message: `Skill '${input.skillId}' updated.`
            })
          }

          // String-level patch
          if (input.patchOldString !== undefined && input.patchNewString !== undefined) {
            if (!existsSync(skillMdPath)) return `Error: SKILL.md not found for: ${input.skillId}`
            const current = readFileSync(skillMdPath, "utf-8")
            if (!current.includes(input.patchOldString)) {
              return `Error: patchOldString not found in SKILL.md. Read the skill first with action='view'.`
            }
            const updated = current.replace(input.patchOldString, input.patchNewString)
            writeFileSync(skillMdPath, updated, "utf-8")
            invalidateEnabledSkillsCache()
            notifyRenderer("skills:changed")
            console.log(`[SkillEvolution] Patched (string replace) skill: ${input.skillId}`)
            return JSON.stringify({
              success: true,
              skillId: input.skillId,
              mode: "string_replace",
              message: `Skill '${input.skillId}' patched.`
            })
          }

          return "Error: for patch, provide either 'content' (full replace) or 'patchOldString' + 'patchNewString' (string replace)"
        }

        // ── delete ────────────────────────────────────────
        case "delete": {
          if (!input.skillId) return "Error: skillId is required for delete"
          const skillDir = join(getCustomSkillsDir(), input.skillId)
          if (!existsSync(skillDir)) return `Error: skill not found: ${input.skillId}`

          rmSync(skillDir, { recursive: true, force: true })
          invalidateEnabledSkillsCache()
          notifyRenderer("skills:changed")

          console.log(`[SkillEvolution] Deleted skill: ${input.skillId}`)
          return JSON.stringify({
            success: true,
            skillId: input.skillId,
            message: `Skill '${input.skillId}' deleted.`
          })
        }

        default:
          return `Error: unknown action: ${input.action}`
      }
    },
    {
      name: "manage_skill",
      description:
        "Create, view, improve, or delete custom reusable skills.\n\n" +
        "A skill is a SKILL.md file that injects specialized instructions into the agent " +
        "whenever a matching task is detected. Skills are stored in ~/.cmbcoworkagent/skills/ " +
        "and are automatically loaded in future conversations.\n\n" +
        "WHEN TO CREATE A SKILL:\n" +
        "After completing a complex task that took 5+ tool calls, consider whether the approach " +
        "could be reused. If so, capture it as a skill. Good skill candidates:\n" +
        "- Repeated workflows (e.g. 'deploy to staging', 'write unit tests for this codebase')\n" +
        "- Domain-specific knowledge (e.g. project conventions, API patterns)\n" +
        "- Multi-step procedures that required trial and error to figure out\n\n" +
        "SKILL.md FORMAT:\n" +
        "```\n" +
        "---\n" +
        "name: my-skill-name\n" +
        "description: One sentence describing WHEN to use this skill (triggers it)\n" +
        "version: 1.0.0\n" +
        "---\n\n" +
        "# My Skill Title\n\n" +
        "Step-by-step instructions the agent should follow...\n" +
        "```\n\n" +
        "ACTIONS:\n" +
        "- list: Show all custom skills and their trigger descriptions\n" +
        "- view: Read the full SKILL.md content of a specific skill\n" +
        "- create: Write a new skill (requires name, description, content)\n" +
        "- patch: Update a skill — either full content replace or targeted string replace\n" +
        "- delete: Remove a skill permanently\n\n" +
        "PATCHING TIPS:\n" +
        "- Use action='view' first to read the current content\n" +
        "- Use patchOldString + patchNewString for targeted updates\n" +
        "- Use content for a full rewrite\n\n" +
        "NOTE: New or updated skills take effect in the NEXT conversation, not the current one.",
      schema: skillEvolveSchema
    }
  )
}
