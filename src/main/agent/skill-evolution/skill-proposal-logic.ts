/**
 * Pure functions for the skill proposal flow.
 * No Electron, no LLM, no IPC — fully unit-testable.
 */

// ─────────────────────────────────────────────────────────
// Worthiness judgement
// ─────────────────────────────────────────────────────────

export interface WorthinessResult {
  worthy: boolean
  reason: string
}

export type SkillProposalMode = "mode_a_rule" | "mode_b_llm"

/**
 * Build the system prompt that asks the LLM to judge whether a conversation
 * is worth saving as a reusable skill.
 * Injects the actual threshold and tool-call count so the model has
 * concrete numbers for condition #1.
 */
export function buildWorthinessPrompt(toolCallCount: number, threshold: number): string {
  return `You are an expert at evaluating whether an AI agent conversation is worth saving as a reusable skill.

Save this conversation as a skill if it meets ANY ONE of these conditions:
1. Complex task completed successfully — the agent used ${threshold}+ tool calls (this conversation had ${toolCallCount})
2. Tricky error resolved — the agent encountered errors/failures but found a working solution
3. Non-obvious workflow discovered — the agent used tools in a creative or domain-specific sequence that isn't immediately obvious
4. User correction led to success — the user corrected the agent's approach and the task ultimately succeeded
5. User explicitly asked to remember the process — the user said something like "remember this", "save this workflow", "next time do it this way"

Do NOT save when:
- Simple Q&A or single-step lookup with no meaningful workflow
- Task failed or was left incomplete
- Purely one-off data operation (e.g. "what is the value in row 5") with no reusable pattern
- The only skill you could write would be narrowly tied to a specific file, component, bug, or artifact — with no transferable method that would help with similar tasks in other contexts

Key question to ask yourself: "Can I name a generalized task family this skill belongs to (e.g. 'code bug investigation', 'API integration debugging', 'git conflict resolution') rather than just restating the specific task?"
If yes → worthy. If no → not worthy.

Output ONLY a single JSON object, no markdown:
{"worthy": true, "reason": "one sentence naming the generalized task family and why it's reusable"}
or
{"worthy": false, "reason": "one sentence why the workflow is too narrow or not transferable"}`
}

/**
 * Strip reasoning-model artifacts (<think> blocks) and markdown fences,
 * then attempt to parse the LLM's JSON response.
 * Returns null if the text cannot be parsed.
 */
export function parseWorthinessResponse(raw: string): WorthinessResult | null {
  const parsed = parseJsonObjectFromModelText(raw) as { worthy?: unknown; reason?: unknown } | null
  if (!parsed || typeof parsed.worthy !== "boolean") return null
  return {
    worthy: parsed.worthy,
    reason: typeof parsed.reason === "string" ? parsed.reason : ""
  }
}

// ─────────────────────────────────────────────────────────
// Proposal generation
// ─────────────────────────────────────────────────────────

export interface SkillProposal {
  name: string
  skillId: string
  description: string
  content: string
}

function extractJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = []

  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0
    let inString = false
    let escaping = false

    for (let i = start; i < text.length; i++) {
      const ch = text[i]

      if (inString) {
        if (escaping) {
          escaping = false
          continue
        }
        if (ch === "\\") {
          escaping = true
          continue
        }
        if (ch === "\"") {
          inString = false
        }
        continue
      }

      if (ch === "\"") {
        inString = true
        continue
      }

      if (ch === "{") {
        depth += 1
        continue
      }

      if (ch === "}") {
        depth -= 1
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1))
          break
        }
      }
    }
  }

  return candidates
}

function parseJsonObjectFromModelText(raw: string): Record<string, unknown> | null {
  const cleaned = stripLLMFormatting(raw)

  try {
    return JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    const candidates = extractJsonObjectCandidates(cleaned)
    for (let i = candidates.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(candidates[i]) as Record<string, unknown>
      } catch {
        continue
      }
    }
    return null
  }
}

/**
 * Parse the LLM's skill proposal JSON response.
 * Returns null if the text cannot be parsed or required fields are missing.
 */
export function parseSkillProposal(raw: string): SkillProposal | null {
  const parsed = parseJsonObjectFromModelText(raw) as {
    name?: unknown
    skillId?: unknown
    description?: unknown
    content?: unknown
  } | null
  if (
    !parsed ||
    typeof parsed.name !== "string" ||
    typeof parsed.skillId !== "string" ||
    typeof parsed.description !== "string" ||
    typeof parsed.content !== "string"
  ) {
    return null
  }
  return {
    name: parsed.name,
    skillId: parsed.skillId,
    description: parsed.description,
    content: parsed.content
  }
}

// ─────────────────────────────────────────────────────────
// Trigger decision
// ─────────────────────────────────────────────────────────

export function getSkillProposalMode(autoProposeEnabled: boolean): SkillProposalMode {
  return autoProposeEnabled ? "mode_a_rule" : "mode_b_llm"
}

export function shouldJudgeSkillWorthiness(mode: SkillProposalMode): boolean {
  return mode === "mode_b_llm"
}

export function shouldEvaluateSkillProposalWindow(toolCallCount: number, threshold: number): boolean {
  return toolCallCount >= threshold
}

/**
 * Decide whether to enter the proposal flow after the threshold has already
 * been hit and skill-usage short-circuiting has already been handled.
 */
export function shouldProposeSkill(mode: SkillProposalMode, llmWorthy: boolean): boolean {
  return mode === "mode_a_rule" ? true : llmWorthy
}

// ─────────────────────────────────────────────────────────
// Shared text cleaning
// ─────────────────────────────────────────────────────────

/**
 * Remove <think>...</think> reasoning blocks (deepseek-r1 etc.) and
 * markdown code fences, then trim whitespace.
 */
export function stripLLMFormatting(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .replace(/^```json\s*/im, "")
    .replace(/^```\s*/im, "")
    .replace(/```\s*$/im, "")
    .trim()
}
