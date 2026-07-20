/**
 * Expert agent library ("专家团"): curated agent profiles adapted from
 * oh-my-claudecode (MIT, https://github.com/Yeachan-Heo/oh-my-claudecode).
 *
 * Curation decisions (2026-07):
 *  - OMC's explore/planner/verifier are EXCLUDED — they duplicate this
 *    project's built-in Explore/Plan/verification profiles.
 *  - Tool policy is assigned here, per agent, using the registry's
 *    disallowedTools + shellAccess model (OMC's .md files carry no tool
 *    policy and would default to full access).
 *  - OMC's model tiers (opus/sonnet/haiku) are dropped; every profile
 *    inherits the session model, same as the built-ins.
 *  - Prompts are rewritten against this project's tool names
 *    (read_file/write_file/edit_file/execute/glob/grep/write_todos) with
 *    OMC-specific systems (LSP/ast-grep tools, Task() consultation, .omc
 *    paths, ralplan) removed.
 *
 * None of these are active by default: loadAgentProfiles only includes the
 * ones the user enabled in the 专家团 settings page (see
 * registerEnabledLibraryAgentsReader in agent-registry.ts).
 */
import type { AgentProfile } from "../agent-registry"
import { ANALYST_PROFILE } from "./analyst"
import { ARCHITECT_PROFILE } from "./architect"
import { CODE_REVIEWER_PROFILE } from "./code-reviewer"
import { CODE_SIMPLIFIER_PROFILE } from "./code-simplifier"
import { CRITIC_PROFILE } from "./critic"
import { DEBUGGER_PROFILE } from "./debugger"
import { DESIGNER_PROFILE } from "./designer"
import { DOCUMENT_SPECIALIST_PROFILE } from "./document-specialist"
import { EXECUTOR_PROFILE } from "./executor"
import { GIT_MASTER_PROFILE } from "./git-master"
import { QA_TESTER_PROFILE } from "./qa-tester"
import { SCIENTIST_PROFILE } from "./scientist"
import { SECURITY_REVIEWER_PROFILE } from "./security-reviewer"
import { TEST_ENGINEER_PROFILE } from "./test-engineer"
import { TRACER_PROFILE } from "./tracer"
import { WRITER_PROFILE } from "./writer"

export const LIBRARY_AGENT_PROFILES: readonly AgentProfile[] = [
  ANALYST_PROFILE,
  ARCHITECT_PROFILE,
  CODE_REVIEWER_PROFILE,
  CODE_SIMPLIFIER_PROFILE,
  CRITIC_PROFILE,
  DEBUGGER_PROFILE,
  DESIGNER_PROFILE,
  DOCUMENT_SPECIALIST_PROFILE,
  EXECUTOR_PROFILE,
  GIT_MASTER_PROFILE,
  QA_TESTER_PROFILE,
  SCIENTIST_PROFILE,
  SECURITY_REVIEWER_PROFILE,
  TEST_ENGINEER_PROFILE,
  TRACER_PROFILE,
  WRITER_PROFILE
]
