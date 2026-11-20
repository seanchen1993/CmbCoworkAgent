/**
 * Protocol for slash-command skill invocations — v2 (simplified).
 *
 * We emit ONE tag pair at the END of the user message:
 *
 *   <CMBDEVCLAW-SKILL-USE-V1>
 *     <instruction>
 *     请先使用 read 工具读取 <path> 指定的 SKILL.md ...
 *     </instruction>
 *     <name>skill-name</name>
 *     <path>/abs/path/to/SKILL.md</path>
 *   </CMBDEVCLAW-SKILL-USE-V1>
 *
 * No SKILL.md body inlined — the model is told to read the file via the `read`
 * tool. That deliberately collapses v1's two-tag protocol (<skill-invocation-
 * instruction> + <skill>body</skill>) into one block, and skips all the
 * body-defuse / anti-spoof machinery v1 needed.
 *
 * Tag name is deliberately "loud" (ALL-CAPS, project-branded, versioned):
 *   - Doesn't collide with HTML/Markdown the user might actually type.
 *   - Versioned so a future v2 can coexist without silent misparse.
 *   - Main process recognizes this marker to activate run-scoped skill hooks,
 *     while still forwarding the full wrapped payload so the model reads the
 *     selected SKILL.md via read_file.
 */

export {
  formatSkillUseBlock,
  skillUseDisplayLabel,
  stripSkillUseBlockForDisplay
} from "../../../../shared/skill-use-block"
import { parseSkillUseBlock as parseSharedSkillUseBlock } from "../../../../shared/skill-use-block"

/**
 * Locate the trailing `<CMBDEVCLAW-SKILL-USE-V1>…</CMBDEVCLAW-SKILL-USE-V1>`
 * block inside a message string.
 *
 * Tail-anchored on purpose: the block is always at the end of the model-facing
 * payload, and `lastIndexOf` survives even if the user's own prose happens to
 * contain the literal tag before the real transport block.
 *
 * This is protocol data, not just cosmetic UI metadata: main-side code also
 * reads a valid tail block to activate the explicitly selected skill. User
 * prose that ends with a complete, valid block is therefore still ambiguous
 * until the composer sends skills out-of-band instead of as text.
 *
 * Returns null if no matching block exists, or if the block has no valid <name>.
 */
export function parseSkillUseBlock(
  content: string
): { skillName: string; skillPath: string; rest: string } | null {
  const parsed = parseSharedSkillUseBlock(content)
  return parsed ? { skillName: parsed.skillName, skillPath: parsed.skillPath, rest: parsed.rest } : null
}
