/**
 * Expert agent library (专家团) enablement tests.
 *
 * Covers the injected enabled-list reader in agent-registry.ts and the curated
 * LIBRARY_AGENT_PROFILES invariants. Run with: npx tsx tests/expert-agent-library.spec.ts
 *
 * The whole run executes under an ISOLATED HOME (same technique as
 * agent-registry.spec.ts): loadAgentProfiles() reads ~/.cmbcoworkagent/agents,
 * and a stray global agent file named like a library agent (e.g. architect.md)
 * would override the library layer and break assertions non-deterministically.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  loadAgentProfiles,
  registerEnabledLibraryAgentsReader,
  resolveAgentProfile,
  BUILT_IN_AGENT_PROFILES
} from "../src/main/agent/agent-registry.ts"
import { LIBRARY_AGENT_PROFILES } from "../src/main/agent/library/index.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function makeWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cmb-expert-lib-"))
  const dir = join(root, ".cmbcoworkagent", "agents")
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf-8")
  }
  return root
}

function resetReader(): void {
  registerEnabledLibraryAgentsReader(() => [])
}

// ── Library curation invariants ──

function testLibraryInvariants(): void {
  // The registration list in library/index.ts is hand-maintained; the realistic
  // mistake is adding a profile FILE but forgetting the index entry. Derive the
  // expected count from the directory instead of hardcoding it.
  const libraryDir = join(__dirname, "..", "src", "main", "agent", "library")
  const profileFiles = readdirSync(libraryDir).filter(
    (f) => f.endsWith(".ts") && f !== "index.ts"
  )
  assert(
    LIBRARY_AGENT_PROFILES.length === profileFiles.length,
    `every library profile file is registered in index.ts (${profileFiles.length} files vs ${LIBRARY_AGENT_PROFILES.length} registered)`
  )

  const builtInLower = new Set(BUILT_IN_AGENT_PROFILES.map((p) => p.name.toLowerCase()))
  for (const p of LIBRARY_AGENT_PROFILES) {
    assert(p.source === "library", `${p.name}: source is "library"`)
    assert(
      !builtInLower.has(p.name.toLowerCase()),
      `${p.name}: must not collide with a built-in name (case-insensitive) — a collision would ` +
        `silently replace the built-in via the registry's canonical-key collapse`
    )
    assert(p.model === undefined, `${p.name}: inherits the session model (no model override)`)
    // Prompts were rewritten for this project's tool names; OMC tool/system
    // names must not leak through (they'd instruct the model to call tools
    // that don't exist here).
    for (const leaked of [
      "lsp_diagnostics",
      "ast_grep",
      "python_repl",
      "TodoWrite",
      ".omc/",
      "subagent_type=",
      "wrapWithPreamble"
    ]) {
      assert(!p.systemPrompt.includes(leaked), `${p.name}: prompt must not reference "${leaked}"`)
    }
    // Read-only/verify agents must actually be write-blocked, not just told so.
    if (p.disallowedTools.includes("write_file")) {
      assert(p.disallowedTools.includes("edit_file"), `${p.name}: write_file blocked implies edit_file blocked`)
    }
  }

  const names = new Set(LIBRARY_AGENT_PROFILES.map((p) => p.name))
  assert(names.size === LIBRARY_AGENT_PROFILES.length, "library names are unique")
  for (const dropped of ["explore", "planner", "verifier"]) {
    assert(!names.has(dropped), `OMC "${dropped}" is excluded (duplicates a built-in)`)
  }
}

// ── Enablement filtering via the injected reader ──

function testEnablementFiltering(): void {
  resetReader()
  const noneEnabled = loadAgentProfiles()
  assert(
    !noneEnabled.some((p) => p.source === "library"),
    "default reader → no library profiles in the registry"
  )
  assert(
    BUILT_IN_AGENT_PROFILES.every((b) => noneEnabled.some((p) => p.name === b.name)),
    "built-ins always present regardless of library enablement"
  )

  registerEnabledLibraryAgentsReader(() => ["architect", "executor"])
  const twoEnabled = loadAgentProfiles()
  const libNames = twoEnabled.filter((p) => p.source === "library").map((p) => p.name).sort()
  assert(
    JSON.stringify(libNames) === JSON.stringify(["architect", "executor"]),
    `only the enabled subset is loaded (got ${JSON.stringify(libNames)})`
  )
  const architect = resolveAgentProfile("architect")
  assert(architect?.source === "library", "enabled library profile resolves by exact name")
  assert(
    architect?.disallowedTools.includes("write_file") && architect?.shellAccess === "read_only",
    "architect keeps its curated read-only policy through resolution"
  )

  // Unknown / stale names in the stored list are skipped silently — including
  // names that only exist in a newer/older library version.
  registerEnabledLibraryAgentsReader(() => ["architect", "no-such-agent"])
  const withStale = loadAgentProfiles().filter((p) => p.source === "library")
  assert(withStale.length === 1 && withStale[0].name === "architect", "stale names skipped")

  // End-state invariant: enabling built-in names (any casing) must never let
  // anything shadow a built-in profile. Today this holds because the curation
  // assertion above keeps library names disjoint from built-ins AND
  // loadEnabledLibraryProfiles carries a runtime guard that refuses colliding
  // profiles; this assertion is the regression sentinel for the combination.
  registerEnabledLibraryAgentsReader(() => ["Explore", "explore", "architect"])
  const guarded = loadAgentProfiles()
  const explore = guarded.find((p) => p.name === "Explore")
  assert(explore?.source === "built-in", "built-in Explore is never shadowed via enablement")

  // A throwing reader degrades to "none enabled" instead of breaking the registry.
  registerEnabledLibraryAgentsReader(() => {
    throw new Error("store exploded")
  })
  const afterThrow = loadAgentProfiles()
  assert(
    !afterThrow.some((p) => p.source === "library") &&
      afterThrow.some((p) => p.name === "Explore"),
    "reader throw → no library profiles, built-ins unaffected"
  )

  resetReader()
}

// ── Layering: user .md overrides an enabled library profile of the same name ──

function testUserOverridesLibrary(): void {
  registerEnabledLibraryAgentsReader(() => ["executor"])
  const ws = makeWorkspace({
    "executor.md": `---\nname: executor\ndescription: project executor\nworkload: read_only\n---\nProject-specific executor.`
  })
  try {
    const profiles = loadAgentProfiles(ws)
    const executors = profiles.filter((p) => p.name === "executor")
    assert(executors.length === 1, "same-name library+user collapse to one entry")
    assert(executors[0].source === "user", "workspace .md wins over the library profile")
    assert(
      executors[0].disallowedTools.includes("write_file") &&
        executors[0].shellAccess === "read_only",
      "the user override's tool policy is the effective one"
    )
  } finally {
    rmSync(ws, { recursive: true, force: true })
    resetReader()
  }
}

// ── Run under an isolated HOME so the host's global ~/.cmbcoworkagent/agents
//    can't override library profiles and break assertions (same technique as
//    agent-registry.spec.ts). ──
const isolatedHome = mkdtempSync(join(tmpdir(), "cmb-expert-lib-home-"))
const origHome = process.env.HOME
const origUserProfile = process.env.USERPROFILE
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
try {
  testLibraryInvariants()
  testEnablementFiltering()
  testUserOverridesLibrary()
} finally {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  if (origUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = origUserProfile
  rmSync(isolatedHome, { recursive: true, force: true })
}
console.log("expert-agent-library.spec.ts: all tests passed")
