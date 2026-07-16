import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { join } from "path"
import {
  loadAgentProfiles,
  resolveAgentProfile,
  normalizeToolName,
  stripBlockedToolDocs,
  stripCustomModelPrefix,
  BUILT_IN_AGENT_PROFILES,
  WRITE_TOOL_NAMES
} from "../src/main/agent/agent-registry.ts"
import {
  blockedToolNamesForAccess,
  registryAgentBlockedTools
} from "../src/main/agent/coordinator-worker-access.ts"
import {
  assessCommandSafety,
  isReadOnlyShellCommand,
  classifyCommandConcurrency
} from "../src/main/agent/exec-policy.ts"
import {
  BUILD_TOOL_EXECUTABLES,
  isReadOnlyBuildToolInvocation,
  normalizeBuildToolExecutable
} from "../src/main/agent/read-only-build-tool.ts"
import { renderAvailableDeferredToolsPrompt } from "../src/main/agent/system-prompt.ts"
import {
  isReadOnlyPowerShellCommand,
  isSafePowerShellCommand
} from "../src/main/agent/windows-safe-commands.ts"
import { SystemMessage } from "@langchain/core/messages"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

/** Make a throwaway workspace with `.cmbcoworkagent/agents/<name>.md` files. */
function makeWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cmb-agents-"))
  const dir = join(root, ".cmbcoworkagent", "agents")
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf-8")
  }
  return root
}

function testBuiltInsPresent(): void {
  const names = BUILT_IN_AGENT_PROFILES.map((p) => p.name)
  // CC-aligned naming: capital Explore/Plan, lowercase verification.
  for (const expected of ["Explore", "Plan", "verification"]) {
    assert(names.includes(expected), `built-in "${expected}" must exist`)
  }
  const byName = new Map(BUILT_IN_AGENT_PROFILES.map((p) => [p.name, p]))
  // Explore / Plan: block writes, read-only shell.
  for (const ro of ["Explore", "Plan"]) {
    const p = byName.get(ro)!
    assert(p.disallowedTools.includes("write_file"), `${ro} blocks write_file`)
    assert(p.disallowedTools.includes("edit_file"), `${ro} blocks edit_file`)
    assert(p.shellAccess === "read_only", `${ro} has read-only shell`)
  }
  // verification: block writes but keep full shell (runs build/tests).
  const v = byName.get("verification")!
  assert(v.disallowedTools.includes("write_file"), "verification blocks write_file")
  assert(v.shellAccess === "full", "verification keeps full shell")
  for (const p of BUILT_IN_AGENT_PROFILES) {
    assert(p.source === "built-in", `${p.name} source must be built-in`)
    assert(p.systemPrompt.length > 0, `${p.name} must have a system prompt`)
    // execute is governed by shellAccess, never listed in disallowedTools.
    assert(!p.disallowedTools.includes("execute"), `${p.name}: execute is shell-gated`)
  }
  assert(!names.includes("general-purpose"), "general-purpose must NOT be a registry built-in")
}

function testBuiltInPromptParity(): void {
  // Built-in prompts mirror Claude Code's wording (tool names adapted).
  const byName = new Map(BUILT_IN_AGENT_PROFILES.map((p) => [p.name, p]))
  const explore = byName.get("Explore")!.systemPrompt
  assert(explore.includes("file search specialist"), "Explore reproduces CC opener")
  assert(explore.includes("READ-ONLY MODE"), "Explore reproduces CC read-only banner")
  assert(
    explore.includes("read_file") && !explore.includes("Use Read when"),
    "Explore prompt adapted to project tool names"
  )
  const plan = byName.get("Plan")!.systemPrompt
  assert(plan.includes("software architect"), "Plan reproduces CC opener")
  assert(plan.includes("Critical Files for Implementation"), "Plan reproduces CC output section")
  const verify = byName.get("verification")!.systemPrompt
  assert(verify.includes("try to break it"), "verification reproduces CC philosophy")
  assert(verify.includes("VERDICT:"), "verification reproduces CC verdict format")
  // Sections that were trimmed earlier and have now been restored to CC parity.
  assert(
    verify.includes("ADVERSARIAL PROBES"),
    "verification includes the ADVERSARIAL PROBES section"
  )
  assert(
    verify.includes("BEFORE ISSUING FAIL"),
    "verification includes the BEFORE ISSUING FAIL section"
  )
  assert(
    verify.includes("Database migrations") && verify.includes("Infrastructure/config changes"),
    "verification includes the full change-type strategy list"
  )
  assert(
    verify.includes("RECOGNIZE YOUR OWN RATIONALIZATIONS"),
    "verification keeps the rationalizations section"
  )
}

function testWriteToolNames(): void {
  // CC parity: the plain write tools are write_file/edit_file; execute is
  // governed separately by shellAccess.
  assert(
    (WRITE_TOOL_NAMES as readonly string[]).includes("write_file") &&
      (WRITE_TOOL_NAMES as readonly string[]).includes("edit_file"),
    "WRITE_TOOL_NAMES must include write_file + edit_file"
  )
  assert(
    !(WRITE_TOOL_NAMES as readonly string[]).includes("execute"),
    "execute is shell-gated, not a plain write tool"
  )
}

function testCcToolNameMapping(): void {
  assert(normalizeToolName("Read") === "read_file", "Read → read_file")
  assert(normalizeToolName("Edit") === "edit_file", "Edit → edit_file")
  assert(normalizeToolName("Write") === "write_file", "Write → write_file")
  assert(normalizeToolName("Bash") === "execute", "Bash → execute")
  assert(normalizeToolName("Grep") === "grep", "Grep → grep")
  assert(normalizeToolName("Glob") === "glob", "Glob → glob")
  assert(normalizeToolName("Bash(git log:*)") === "execute", "CC permission syntax → execute")
  assert(normalizeToolName("read_file") === "read_file", "native name passes through")
  assert(normalizeToolName("NotebookEdit") === null, "tool with no equivalent → null")
}

function testWorkloadShortcut(): void {
  const ws = makeWorkspace({
    "ro.md": `---\nname: ro\nworkload: read_only\n---\nbody`,
    "vf.md": `---\nname: vf\nworkload: verify\n---\nbody`,
    "wr.md": `---\nname: wr\nworkload: write\n---\nbody`
  })
  try {
    const ps = loadAgentProfiles(ws)
    const ro = ps.find((p) => p.name === "ro")!
    const vf = ps.find((p) => p.name === "vf")!
    const wr = ps.find((p) => p.name === "wr")!
    assert(
      ro.shellAccess === "read_only" && ro.disallowedTools.includes("write_file"),
      "read_only shortcut"
    )
    assert(
      vf.shellAccess === "full" && vf.disallowedTools.includes("write_file"),
      "verify shortcut keeps shell"
    )
    assert(
      wr.shellAccess === "full" && wr.disallowedTools.length === 0,
      "write shortcut = full tools"
    )
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

function testFrontmatterFieldsCaseInsensitive(): void {
  // Frontmatter field NAMES are matched case-insensitively. A miscased
  // `Workload:`/`Tools:`/`DisallowedTools:` must NOT silently fall through to the
  // permissive default (full shell, empty denylist) — that would quietly widen an
  // agent the author meant to restrict.
  const ws = makeWorkspace({
    "wl.md": `---\nname: wl\nWorkload: read_only\n---\nbody`,
    "tl.md": `---\nname: tl\nTools: Read, Grep\n---\nbody`,
    "dl.md": `---\nname: dl\nDisallowedTools: Write, Edit\n---\nbody`
  })
  try {
    const ps = loadAgentProfiles(ws)
    const wl = ps.find((p) => p.name === "wl")!
    assert(
      wl.shellAccess === "read_only" && wl.disallowedTools.includes("write_file"),
      "capital `Workload:` is honored (not defaulted to full)"
    )
    const tl = ps.find((p) => p.name === "tl")!
    assert(
      tl.shellAccess === "none" && tl.disallowedTools.includes("write_file"),
      "capital `Tools:` allowlist is honored (no Bash → no shell)"
    )
    const dl = ps.find((p) => p.name === "dl")!
    assert(
      dl.disallowedTools.includes("write_file") && dl.disallowedTools.includes("edit_file"),
      "capital `DisallowedTools:` denylist is honored"
    )
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

function testCcStyleToolsFrontmatter(): void {
  const ws = makeWorkspace({
    // allowlist of just Read + Grep → everything else blocked, no shell
    "allow.md": `---\nname: allow\ntools: Read, Grep\n---\nbody`,
    // CC-name denylist: block writes, keep shell
    "deny.md": `---\nname: deny\ndisallowedTools: Write, Edit\n---\nbody`,
    // denylist Bash → no shell, execute not surfaced in disallowedTools
    "noshell.md": `---\nname: noshell\ndisallowedTools: Bash\n---\nbody`,
    // allowlist including Bash → full shell
    "withbash.md": `---\nname: withbash\ntools: Read, Bash\n---\nbody`,
    // YAML inline array form (CC supports it) must parse like the comma form
    "arr.md": `---\nname: arr\ntools: ["Read", "Grep"]\n---\nbody`,
    // legacy SPACE-separated form must still parse like the comma form (not regress
    // into one bogus "Read Grep" token → near-fully-disabled profile)
    "spc.md": `---\nname: spc\ntools: Read Grep\n---\nbody`
  })
  try {
    const ps = loadAgentProfiles(ws)
    const allow = ps.find((p) => p.name === "allow")!
    assert(
      allow.disallowedTools.includes("write_file") && allow.disallowedTools.includes("edit_file"),
      "allowlist blocks non-listed write tools"
    )
    assert(allow.shellAccess === "none", "allowlist without Bash → no shell")
    assert(
      !allow.disallowedTools.includes("read_file") && !allow.disallowedTools.includes("grep"),
      "allowlisted tools survive"
    )
    const deny = ps.find((p) => p.name === "deny")!
    assert(
      deny.disallowedTools.includes("write_file") && deny.disallowedTools.includes("edit_file"),
      "denylist with CC names is mapped to project names"
    )
    assert(deny.shellAccess === "full", "denylist without Bash keeps shell")
    const noshell = ps.find((p) => p.name === "noshell")!
    assert(noshell.shellAccess === "none", "disallow Bash → no shell")
    assert(
      !noshell.disallowedTools.includes("execute"),
      "execute represented by shellAccess, not denylist"
    )
    const withbash = ps.find((p) => p.name === "withbash")!
    assert(withbash.shellAccess === "full", "allowlist including Bash → full shell")
    // YAML inline array tools must behave like the comma form (Read+Grep allowlist).
    const arr = ps.find((p) => p.name === "arr")!
    assert(
      arr.disallowedTools.includes("write_file") &&
        !arr.disallowedTools.includes("read_file") &&
        !arr.disallowedTools.includes("grep"),
      "YAML inline array tools parse like comma form (not silently disabling everything)"
    )
    assert(arr.shellAccess === "none", "array allowlist without Bash → no shell (parsed correctly)")
    // space-separated form parses like the comma form (Read+Grep allowlist), not a
    // single "Read Grep" token that would disable nearly everything.
    const spc = ps.find((p) => p.name === "spc")!
    assert(
      spc.disallowedTools.includes("write_file") &&
        !spc.disallowedTools.includes("read_file") &&
        !spc.disallowedTools.includes("grep"),
      "space-separated tools parse like comma form (no regression to near-fully-disabled)"
    )
    assert(spc.shellAccess === "none", "space-separated allowlist without Bash → no shell")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

function testLoadUserAgentDefaults(): void {
  const ws = makeWorkspace({
    "loose.md": `Just a body, no frontmatter.`,
    "expert.md": `---\nname: expert\ndescription: DB specialist\nworkload: read_only\nmodel: my-model\n---\nYou are a database expert.`,
    "notes.txt": `ignored`
  })
  try {
    const ps = loadAgentProfiles(ws)
    const loose = ps.find((p) => p.name === "loose")!
    assert(!!loose, "file with no frontmatter loads with filename as name")
    assert(
      loose.shellAccess === "full" && loose.disallowedTools.length === 0,
      "no frontmatter → full tools"
    )
    assert(loose.systemPrompt.includes("Just a body"), "body used as prompt")
    const expert = ps.find((p) => p.name === "expert")!
    assert(expert.description === "DB specialist", "description parsed")
    assert(expert.model === "my-model", "model parsed")
    assert(expert.shellAccess === "read_only", "workload shortcut parsed")
    assert(expert.source === "user", "loaded file is source=user")
    assert(expert.systemPrompt.startsWith("You are a database expert"), "body becomes systemPrompt")
    assert(!ps.find((p) => p.name === "notes"), ".txt file is ignored")
    // built-ins still present alongside the user agents
    assert(!!ps.find((p) => p.name === "Explore"), "built-in Explore still present")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

function testUserOverridesBuiltIn(): void {
  const ws = makeWorkspace({
    "Explore.md": `---\nname: Explore\ndescription: my custom explorer\nworkload: write\n---\nCustom explore behaviour.`
  })
  try {
    const explore = resolveAgentProfile("Explore", ws)!
    assert(!!explore, "Explore resolves")
    assert(explore.source === "user", "project file overrides built-in Explore")
    assert(
      explore.shellAccess === "full" && explore.disallowedTools.length === 0,
      "override → full tools"
    )
    assert(explore.description === "my custom explorer", "override description applied")
    const count = loadAgentProfiles(ws).filter((p) => p.name === "Explore").length
    assert(count === 1, `expected one Explore profile, got ${count}`)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

function testUserOverridesBuiltInCaseInsensitively(): void {
  // A user file `explore.md` (lowercase) MUST override the built-in `Explore`,
  // not coexist as a second profile. Otherwise the same logical name resolved to
  // different prompts/shellAccess by casing (explore → user/full, Explore →
  // built-in/read_only) — a privilege footgun for "override the built-in".
  const ws = makeWorkspace({
    "explore.md": `---\nname: explore\ndescription: lowercase override\ntools: Read, Bash\n---\nbody`
  })
  try {
    const profiles = loadAgentProfiles(ws)
    const exploreLike = profiles.filter((p) => p.name.toLowerCase() === "explore")
    assert(
      exploreLike.length === 1 && exploreLike[0].source === "user",
      `case-insensitive collision must yield ONE (user) profile, got ${exploreLike.map((p) => `${p.name}/${p.source}`).join(",")}`
    )
    // Every casing resolves to the SAME (user) override — no case-dependent split.
    for (const t of ["explore", "Explore", "EXPLORE"]) {
      const p = resolveAgentProfile(t, ws)!
      assert(
        p.source === "user" && p.shellAccess === "full",
        `resolve(${t}) must hit the user override (full), got ${p?.source}/${p?.shellAccess}`
      )
    }
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
  // No override → the built-in still resolves under any casing (no regression).
  assert(
    resolveAgentProfile("Explore")?.source === "built-in",
    "built-in Explore intact when not overridden"
  )

  // Cross-layer: a project file overrides a home file of a DIFFERENT casing for the
  // SAME built-in logical name (else both survive, split by casing — e.g. EXPLORE
  // hitting the stale home profile). Home is isolated to a temp dir by the runner.
  const homeAgents = join(homedir(), ".cmbcoworkagent", "agents")
  const homeExplore = join(homeAgents, "explore.md")
  mkdirSync(homeAgents, { recursive: true })
  writeFileSync(homeExplore, `---\nname: explore\ndescription: home\ntools: Read, Bash\n---\nbody`)
  const wsX = makeWorkspace({
    "Explore.md": `---\nname: Explore\ndescription: project\nworkload: read_only\n---\nbody`
  })
  try {
    const exploreLikeX = loadAgentProfiles(wsX).filter((p) => p.name.toLowerCase() === "explore")
    assert(
      exploreLikeX.length === 1,
      `cross-layer: one explore profile expected, got ${exploreLikeX.map((p) => p.name).join(",")}`
    )
    for (const t of ["explore", "Explore", "EXPLORE"]) {
      assert(
        resolveAgentProfile(t, wsX)?.shellAccess === "read_only",
        `cross-layer: resolve(${t}) must hit the project override (read_only), got ${resolveAgentProfile(t, wsX)?.shellAccess}`
      )
    }
  } finally {
    rmSync(homeExplore, { force: true })
    rmSync(wsX, { recursive: true, force: true })
  }

  // Two CUSTOM agents differing only by case must NOT be collapsed (only built-in
  // names are case-folded; custom names resolve exact-only, so collapsing would
  // make the dropped casing resolve to null). On a case-INSENSITIVE filesystem the
  // two files are physically one, so this only exercises on a case-sensitive FS.
  const ws2 = makeWorkspace({
    "DB.md": `---\nname: DB\ndescription: upper\n---\nbody`,
    "db.md": `---\nname: db\ndescription: lower\n---\nbody`
  })
  try {
    const dbLike = loadAgentProfiles(ws2).filter((p) => p.name.toLowerCase() === "db")
    if (dbLike.length === 2) {
      // case-sensitive FS: both kept, both resolve exactly (the regression fix).
      assert(
        resolveAgentProfile("DB", ws2)?.name === "DB" &&
          resolveAgentProfile("db", ws2)?.name === "db",
        "custom case-variant agents both resolve (neither collapsed to null)"
      )
    }
  } finally {
    rmSync(ws2, { recursive: true, force: true })
  }
}

function testResolveUnknown(): void {
  assert(resolveAgentProfile("does-not-exist") === null, "unknown agentType resolves to null")
  assert(resolveAgentProfile("") === null, "empty agentType resolves to null")
  assert(resolveAgentProfile("  ") === null, "whitespace agentType resolves to null")
  assert(
    resolveAgentProfile("Explore")?.name === "Explore",
    "built-in Explore resolves w/o workspace"
  )
  // Built-in names resolve case-insensitively (common typo tolerance); a genuinely
  // unknown name (no exact + no built-in case match) still resolves to null so the
  // workflow engine can fail closed.
  assert(resolveAgentProfile("explore")?.name === "Explore", "miscased built-in resolves (explore)")
  assert(resolveAgentProfile("EXPLORE")?.name === "Explore", "miscased built-in resolves (EXPLORE)")
  assert(resolveAgentProfile("verification")?.name === "verification", "lowercase built-in exact")
  assert(resolveAgentProfile("ghost-agent") === null, "genuinely unknown still null")
}

function testCaseInsensitiveSurvivesUserOverride(): void {
  // A user file overriding a built-in (Explore.md) flips that profile's source to
  // "user". The case-insensitive fallback keys on the NAME (not source), so a
  // lowercase `explore` must STILL resolve to the override — otherwise existing
  // lowercase agentType scripts would start failing closed once someone drops an
  // override (the bug codex caught: case-insensitive was gated on source==="built-in").
  const ws = makeWorkspace({
    "Explore.md": `---\nname: Explore\ndescription: custom explore\nworkload: read_only\n---\nbody`
  })
  try {
    assert(resolveAgentProfile("Explore", ws)?.source === "user", "exact match → user override")
    assert(
      resolveAgentProfile("explore", ws)?.source === "user",
      "lowercase still resolves to the override (not null → no fail-closed regression)"
    )
    assert(
      resolveAgentProfile("EXPLORE", ws)?.source === "user",
      "uppercase still resolves to the override"
    )
    assert(resolveAgentProfile("ghost", ws) === null, "genuinely unknown still null")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

function testStripBlockedToolDocs(): void {
  // The injected fs system prompt advertises tools; a blocked tool's doc line
  // (and, for shellAccess "none", the execute section) must be removed so the
  // model never sees a description of a tool it cannot use (CC parity).
  const prompt = `You have access to a filesystem.

### Available Tools
- ls: list files in a directory
- read_file: read a file from the filesystem
- write_file: write to a file in the filesystem
- edit_file: edit a file in the filesystem
- glob: find files matching a pattern
- grep: search for literal text

## Execute Tool \`execute\`

You have access to an execute tool.
- execute: run a shell command`
  // read-only role: blocked = {write_file, edit_file} (execute NOT blocked) →
  // drop write docs, KEEP execute section.
  const ro = stripBlockedToolDocs(prompt, new Set(["write_file", "edit_file"])) as string
  assert(!ro.includes("- write_file:"), "read_only strips the write_file doc line")
  assert(!ro.includes("- edit_file:"), "read_only strips the edit_file doc line")
  assert(ro.includes("- read_file:") && ro.includes("- grep:"), "read_only keeps read tools")
  assert(ro.includes("## Execute Tool"), "read_only keeps the execute section (read-only shell)")
  // no shell: blocked includes execute → also remove the execute section + line.
  const none = stripBlockedToolDocs(
    prompt,
    new Set(["write_file", "edit_file", "execute", "task_output"])
  ) as string
  assert(!none.includes("- write_file:"), "none strips write_file")
  assert(!none.includes("## Execute Tool"), "none strips the execute section")
  assert(!none.includes("- execute:"), "none strips the execute line")
  assert(none.includes("- read_file:"), "none keeps read_file")
  // non-string passes through; empty blocked is a no-op.
  assert(
    stripBlockedToolDocs(undefined, new Set(["write_file"])) === undefined,
    "non-string system message passes through untouched"
  )
  assert(stripBlockedToolDocs(prompt, new Set([])) === prompt, "no blocked → unchanged")
}

function testCoordinatorReadOnlyKeepsExecute(): void {
  // Coordinator read_only worker now KEEPS execute (gated read-only per command at
  // runtime) + task_output for results; only writes/deferred execution are blocked.
  // verify keeps execute (full); explicit registry mode is unaffected.
  const ro = blockedToolNamesForAccess({ workload: "read_only" })
  assert(!ro.has("execute"), "read_only worker keeps execute (gated read-only)")
  assert(!ro.has("task_output"), "read_only worker keeps task_output for command results")
  assert(ro.has("write_file") && ro.has("edit_file"), "read_only still blocks direct writes")
  const vf = blockedToolNamesForAccess({ workload: "verify" })
  assert(!vf.has("execute"), "verify worker keeps execute (full shell)")
  assert(vf.has("write_file"), "verify worker still blocks writes")
  // explicit mode (registry): read_only shell omits execute from the denylist too.
  const explicit = blockedToolNamesForAccess({
    disallowedTools: ["write_file", "edit_file"],
    shellAccess: "read_only"
  })
  assert(!explicit.has("execute"), "explicit read-only shell keeps execute")
  assert(explicit.has("write_file"), "explicit denylist blocks write_file")
}

// ── Wiring guards: source-level invariants for the 3-mode integration. String
// assertions (the full createAgentRuntime can't run under tsx — needs Electron +
// a configured model), guarding coordinator isolation + correct plumbing.

function readSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf-8").replace(/\r\n?/g, "\n")
}

const RUNTIME_SRC = readSource("../src/main/agent/runtime.ts")
const LOCAL_SANDBOX_SRC = readSource("../src/main/agent/local-sandbox.ts")
const ENGINE_SRC = readSource("../src/main/agent/workflow/engine.ts")
const SUBAGENT_SRC = readSource("../src/main/agent/workflow/subagent.ts")
const ACCESS_SRC = readSource("../src/main/agent/coordinator-worker-access.ts")
const WORKFLOW_TOOL_SRC = readSource("../src/main/agent/workflow/tool.ts")
const CHAT_CONTAINER_SRC = readSource("../src/renderer/src/components/chat/ChatContainer.tsx")

function testLevel2GatedToSoloMainAgent(): void {
  // Requirement 2: registry specs are built ONLY for the Solo main agent.
  assert(
    RUNTIME_SRC.includes('agentMode === "normal" && !disableSubagents'),
    "registry subagent specs are gated to the Solo main agent only"
  )
}

function testLevel2DedupAndMerge(): void {
  assert(RUNTIME_SRC.includes("existingSubagentNames"), "registry dedups against existing names")
  assert(
    RUNTIME_SRC.includes("...registrySubagents"),
    "registry subagents merged into availableSubagents"
  )
  assert(
    RUNTIME_SRC.includes("spec.name !== GENERAL_PURPOSE_SUBAGENT.name"),
    "registry never overrides the built-in general-purpose subagent"
  )
}

function testLevel2ToolGuard(): void {
  // Requirement 1 (correctness): a Solo subagent with a non-default tool policy
  // genuinely loses its tools (hidden from model + calls rejected), and a
  // read-only shell only runs provably read-only commands.
  assert(
    RUNTIME_SRC.includes("createAgentToolGuardMiddleware(disallowed, shell, windowsShellKind)"),
    "every registry subagent gets the guard middleware (always — to cut meta tools)"
  )
  assert(
    RUNTIME_SRC.includes("registryAgentBlockedTools(disallowedTools, shellAccess)"),
    "guard's blocked set comes from registryAgentBlockedTools (incl. ad-hoc-exec/orchestration cut)"
  )
  assert(
    RUNTIME_SRC.includes("blocked.has(t.name)") && RUNTIME_SRC.includes("blocked.has(name)"),
    "guard hides blocked tools (wrapModelCall) and rejects calls (wrapToolCall)"
  )
  assert(
    RUNTIME_SRC.includes('shellAccess === "read_only"') &&
      RUNTIME_SRC.includes("isReadOnlyShellCommand"),
    "read-only shell gates execute commands via isReadOnlyShellCommand"
  )
  assert(
    RUNTIME_SRC.includes("stripBlockedToolDocs(request.systemMessage"),
    "guard also strips blocked tools' docs from the injected system prompt (CC parity)"
  )
}

function testSoloTaskDescriptionsExposeAccessPolicy(): void {
  // Claude Code shows agent access next to each subagent description
  // (`Tools: ...`). Keep Solo Task aligned so the main agent knows, before
  // dispatching, that Explore/Plan are read-only and cannot write.
  assert(
    RUNTIME_SRC.includes(
      "appendRegistrySubagentAccessDescription(spec.description, disallowed, shell)"
    ),
    "Solo registry subagent descriptions include access-policy suffixes"
  )
  assert(
    RUNTIME_SRC.includes('no ${disallowedTools.join("/")}') &&
      RUNTIME_SRC.includes('"read-only shell"') &&
      RUNTIME_SRC.includes('"no shell"') &&
      RUNTIME_SRC.includes('"full shell"'),
    "access-policy suffix names denied tools and shell tier"
  )
}

function testLevel1ToolPlumbing(): void {
  // Requirement 3: agentType tool policy reaches the leaf runtime's
  // filesystemAccess (explicit denylist/shell mode), and the role prompt is set.
  assert(
    RUNTIME_SRC.includes("disallowedTools: subagentOptions.disallowedTools ?? []") &&
      RUNTIME_SRC.includes('shellAccess: subagentOptions.shellAccess ?? "full"'),
    "workflow subagent createRuntime forwards disallowedTools + shellAccess to filesystemAccess"
  )
  assert(
    RUNTIME_SRC.includes('filesystemAccess?.shellAccess === "read_only"') &&
      RUNTIME_SRC.includes("isReadOnlyShellCommand(input.command"),
    "Level-1 execute is gated read-only via isReadOnlyShellCommand"
  )
  assert(
    ACCESS_SRC.includes("isExplicitToolAccess") && ACCESS_SRC.includes("access.disallowedTools"),
    "coordinator-worker-access supports the explicit registry denylist/shell mode"
  )
  assert(
    SUBAGENT_SRC.includes("request.roleSystemPrompt"),
    "subagent prepends the agentType role prompt"
  )
  // Level-1 also strips blocked tools' docs from the injected fs system prompt for
  // ANY restricted access — coordinator workers (workload) AND workflow agents
  // (explicit) — so a removed tool's docs never contradict the tool list. Only
  // the unrestricted main agent (filesystemAccess undefined) keeps the full docs.
  assert(
    RUNTIME_SRC.includes("filesystemSystemPrompt && filesystemAccess") &&
      RUNTIME_SRC.includes("blockedToolNamesForAccess(filesystemAccess)"),
    "Level-1 cleans the fs system prompt for any restricted access (coordinator + workflow)"
  )
}

function testWorkflowAgentTypeLeafConfig(): void {
  // workflow agentType leaves: read-only roles skip AGENTS.md + MEMORY.md injection
  // (CC omitClaudeMd + named agents inject no memory) but KEEP skills + MCP (CC
  // subagents can invoke project/user skills and inherit MCP).
  assert(
    RUNTIME_SRC.includes(
      'subagentOptions.shellAccess === "read_only" || subagentOptions.shellAccess === "none"'
    ),
    "read_only AND none are both restricted roles (a no-shell agent must not get more context than read_only)"
  )
  assert(
    RUNTIME_SRC.includes("enableAgentsPrompt: !restrictedRole"),
    "only full (write/verify) keeps AGENTS.md; restricted roles (read_only/none) skip it (CC omitClaudeMd)"
  )
  assert(
    RUNTIME_SRC.includes("disableMemoryInjection: restrictedRole"),
    "restricted roles (read_only/none) skip MEMORY.md; write/verify keep it (CC: write-capable inherit claudeMd incl. AutoMem)"
  )
  assert(
    RUNTIME_SRC.includes("!disableMemoryInjection && memorySources"),
    "disableMemoryInjection suppresses MEMORY.md injection only"
  )
  // skills are KEPT for named agents (CC subagents can invoke skills): no
  // disableSkills anywhere, and registry agents include the skills middleware.
  assert(
    !RUNTIME_SRC.includes("disableSkills"),
    "disableSkills was removed — named agents keep skill access (CC parity)"
  )
  assert(
    RUNTIME_SRC.includes("...skillsMiddlewareArray"),
    "registry subagents include the skills middleware (discover/invoke skills like general-purpose)"
  )
  assert(
    RUNTIME_SRC.includes("!isExplicitToolAccess(options.filesystemAccess)"),
    "explicit (workflow agentType) access is excluded from the MCP-discovery skip — MCP retained"
  )
}

function testLevel2MemoryInjection(): void {
  // Mirrors CC's DEFAULT (tengu_moth_copse off): the user's auto-MEMORY.md (AutoMem)
  // rides in userContext.claudeMd alongside CLAUDE.md, so a write-capable subagent
  // inherits the WHOLE claudeMd channel (CLAUDE.md≈AGENTS.md + auto-MEMORY.md) and
  // only omitClaudeMd roles (Explore/Plan ≈ our read_only) drop BOTH at once. So
  // write-capable subagents (general-purpose + write/verify registry) GET both
  // AGENTS.md and MEMORY.md; read-only registry subagents omit both. memory_search/
  // memory_get TOOLS are inherited via defaultTools regardless of role.
  assert(
    RUNTIME_SRC.includes("[...skillsMiddlewareArray, ...memoryMiddlewareArray]"),
    "general-purpose subagent gets MEMORY.md injection (write-capable, mirrors CC claudeMd inheritance)"
  )
  assert(
    RUNTIME_SRC.includes('const restrictedRole = shell === "read_only" || shell === "none"'),
    "registry subagents treat read_only AND none as restricted (a no-shell agent must not get more context than read_only)"
  )
  assert(
    RUNTIME_SRC.includes("...(restrictedRole ? [] : memoryMiddlewareArray)"),
    "registry subagents inject MEMORY.md only for write/verify (full); read_only AND none omit it (mirrors CC omitClaudeMd)"
  )
  assert(
    RUNTIME_SRC.includes("!restrictedRole && subagentExtraSystemPrompt"),
    "registry write/verify subagents get AGENTS.md (## Project Instructions); read_only AND none omit it — same split as MEMORY.md (CC omitClaudeMd drops the whole claudeMd channel)"
  )
}

function testRegistryAgentBlockedTools(): void {
  // Registry agents are subagents, not orchestrators: NONE of them get ad-hoc
  // code-exec or orchestration meta tools. read_only/none ALSO drop the
  // deferred-execution bridge (invoke_deferred_tool can run saved code / deferred
  // MCP tools); verify/write keep the bridge. Eager MCP is kept for all.
  const ro = registryAgentBlockedTools(["write_file", "edit_file"], "read_only")
  for (const t of [
    "write_file",
    "edit_file",
    "code_exec",
    "save_code_exec_tool",
    "mcp__node_repl__js",
    "manage_scheduler",
    "manage_skill",
    "invoke_deferred_tool",
    "search_tool",
    "inspect_tool"
  ]) {
    assert(ro.has(t), `read_only agent must block ${t}`)
  }
  assert(!ro.has("execute"), "read_only keeps execute (command-gated read-only)")

  // none: no shell at all, plus no deferred-execution bridge.
  const none = registryAgentBlockedTools([], "none")
  assert(
    none.has("execute") && none.has("task_output") && none.has("invoke_deferred_tool"),
    "none blocks execute/task_output + deferred bridge"
  )

  const vf = registryAgentBlockedTools(["write_file", "edit_file"], "full") // verify-like
  assert(
    vf.has("code_exec") &&
      vf.has("mcp__node_repl__js") &&
      vf.has("manage_scheduler") &&
      vf.has("manage_skill"),
    "verify blocks code-exec/browser-js + orchestration meta tools"
  )
  assert(!vf.has("execute"), "verify keeps execute (full shell)")
  assert(
    !vf.has("invoke_deferred_tool") && !vf.has("search_tool") && !vf.has("inspect_tool"),
    "verify/write keep the deferred bridge (they can already execute)"
  )

  const wr = registryAgentBlockedTools([], "full") // write custom agent
  assert(
    wr.has("code_exec") &&
      wr.has("mcp__node_repl__js") &&
      wr.has("manage_scheduler") &&
      wr.has("manage_skill"),
    "even a write subagent blocks code-exec/browser-js + orchestration meta tools"
  )
  assert(
    !wr.has("write_file") && !wr.has("invoke_deferred_tool"),
    "write subagent keeps write_file + deferred bridge"
  )
}

function testStripCustomModelPrefix(): void {
  // A profile may write `model: foo` or `model: custom:foo`; both must resolve
  // to the SAME custom-model lookup key.
  assert(stripCustomModelPrefix("foo") === "foo", "bare model name passes through")
  assert(stripCustomModelPrefix("custom:foo") === "foo", "custom: prefix is stripped")
  // A custom model whose own id contains a colon must only lose the LEADING
  // custom: scheme, not the inner colon.
  assert(
    stripCustomModelPrefix("custom:vendor:model-1") === "vendor:model-1",
    "only the leading custom: scheme is stripped"
  )
  assert(stripCustomModelPrefix("custom:") === "", "empty after prefix is preserved")

  // Parity: the workflow agentType path PREPENDS custom: (subagent.ts) and the
  // runtime then slices it; the Solo registry path STRIPS then looks up. From the
  // same profile value both must reach the same lookup key. Simulate the workflow
  // round-trip and assert it equals the Solo strip.
  for (const raw of ["foo", "custom:foo", "custom:vendor:model-1"]) {
    const workflowModelId = raw.startsWith("custom:") ? raw : `custom:${raw}`
    const workflowLookup = stripCustomModelPrefix(workflowModelId) // runtime slices custom:
    const soloLookup = stripCustomModelPrefix(raw)
    assert(
      workflowLookup === soloLookup,
      `workflow and Solo must resolve "${raw}" to the same key (got ${workflowLookup} vs ${soloLookup})`
    )
  }

  // The Solo registry model resolver must use the shared strip (not a direct
  // lookup of the raw profile value), and must warn instead of silently
  // inheriting the main model when the config is missing.
  assert(
    RUNTIME_SRC.includes("stripCustomModelPrefix(profileModel)"),
    "resolveRegistryModelInstance normalizes the custom: prefix"
  )
  assert(
    RUNTIME_SRC.includes("not found in custom model configs; inheriting main model"),
    "registry model miss warns instead of silently inheriting"
  )
}

function testExecuteAvailabilityGatesBackgroundExecPrompt(): void {
  // The runtime omits the background-exec (build/install/test) guidance for any
  // runtime whose execute tool is removed. The predicate is
  // `!blockedToolNamesForAccess(access).has("execute")`. Lock which accesses
  // remove execute (→ no guidance) vs keep it (→ guidance retained).
  const removesExecute = (access: Parameters<typeof blockedToolNamesForAccess>[0]): boolean =>
    blockedToolNamesForAccess(access).has("execute")

  // execute REMOVED → backgroundExec guidance must be suppressed.
  assert(removesExecute({ shellAccess: "none" }), "shellAccess none removes execute")
  assert(
    removesExecute({ ownedFiles: ["src/a.ts"], workspacePath: "/tmp/ws" }),
    "scoped write worker removes execute"
  )
  // execute KEPT → guidance is accurate, must be retained.
  assert(!removesExecute({ shellAccess: "read_only" }), "read_only keeps execute")
  assert(!removesExecute({ shellAccess: "full" }), "full keeps execute")
  assert(!removesExecute({ workload: "read_only" }), "read_only worker keeps execute")
  assert(!removesExecute({ workload: "verify" }), "verify worker keeps execute")
  assert(
    !removesExecute({ workload: "write", ownedFiles: [], workspacePath: "/tmp/ws" }),
    "whole-workspace write worker keeps execute"
  )

  // Wiring: the runtime derives executeToolAvailable from blockedToolNamesForAccess
  // and forwards it to getSystemPrompt, which gates the section on the flag.
  assert(
    RUNTIME_SRC.includes("const executeToolAvailable = options.filesystemAccess") &&
      RUNTIME_SRC.includes('blockedToolNamesForAccess(options.filesystemAccess).has("execute")'),
    "runtime computes execute availability from the access policy"
  )
  assert(
    RUNTIME_SRC.includes("executeToolAvailable && !isReadOnlyRuntime"),
    "runtime forwards execute availability to getSystemPrompt"
  )
  assert(
    RUNTIME_SRC.includes("const backgroundExecSection = !includeBackgroundExec"),
    "getSystemPrompt suppresses the background-exec section when execute is unavailable"
  )
  // The build/install/test background-exec guidance must ALSO be suppressed for
  // read_only runtimes: they keep execute but isReadOnlyShellCommand blocks
  // builds/installs, so the guidance would steer them into commands the gate
  // rejects (and contradict the read-only access prompt).
  assert(
    RUNTIME_SRC.includes("const isReadOnlyRuntime =") &&
      RUNTIME_SRC.includes('options.filesystemAccess?.shellAccess === "read_only"'),
    "runtime suppresses background-exec guidance for read_only runtimes"
  )
}

function testPostFsStripRemovesDeepagentsExecuteDoc(): void {
  // deepagents' FilesystemMiddleware RE-APPENDS this EXACT section in its own
  // wrapModelCall whenever the backend supports execution (LocalSandbox always
  // does) — AFTER our createFsMiddleware cleaned the injected prompt. The post-FS
  // strip middleware must remove it for execute-removed runtimes. Mirror the real
  // shape (node_modules/deepagents EXECUTION_SYSTEM_PROMPT) so a deepagents bump
  // that changes the header surfaces here.
  const EXEC_DOC = `## Execute Tool \`execute\`

You have access to an \`execute\` tool for running shell commands in a sandboxed environment.
Use this tool to run commands, scripts, tests, builds, and other shell operations.

- execute: run a shell command in the sandbox (returns output and exit code)`
  const fsPrompt = `You have access to a filesystem.
- read_file: read a file
- write_file: write to a file`
  // What deepagents hands the next (inner) middleware: base + fs prompt + exec doc.
  const finalMsg = (): SystemMessage =>
    new SystemMessage({ content: `BASE PROMPT\n\n${fsPrompt}\n\n${EXEC_DOC}` })
  const contentOf = (msg: unknown): string => (msg as { content: string }).content

  // shellAccess "none" → execute blocked → the re-appended section is gone.
  const noneText = contentOf(
    stripBlockedToolDocs(finalMsg(), blockedToolNamesForAccess({ shellAccess: "none" }))
  )
  assert(
    !noneText.includes("## Execute Tool"),
    "none strips deepagents-appended Execute Tool section"
  )
  assert(!noneText.includes("- execute:"), "none strips the execute tool line")
  assert(noneText.includes("- read_file:"), "none keeps read_file doc (not blocked)")

  // scoped write worker (ownedFiles) → execute blocked too.
  const scopedText = contentOf(
    stripBlockedToolDocs(
      finalMsg(),
      blockedToolNamesForAccess({ ownedFiles: ["src/a.ts"], workspacePath: "/tmp/ws" })
    )
  )
  assert(
    !scopedText.includes("## Execute Tool") && !scopedText.includes("- execute:"),
    "scoped write worker strips deepagents-appended Execute Tool section"
  )

  // read_only → execute KEPT (command-gated) → the section must remain.
  const roText = contentOf(
    stripBlockedToolDocs(finalMsg(), blockedToolNamesForAccess({ shellAccess: "read_only" }))
  )
  assert(
    roText.includes("## Execute Tool") && roText.includes("- execute:"),
    "read_only keeps the Execute Tool section (execute stays, command-gated)"
  )

  // Wiring: the post-FS strip middleware is keyed on the access policy and runs
  // IMMEDIATELY after the deepagents fs middleware (→ inner → it observes the
  // re-appended section; deepagents AgentNode composes first→outermost).
  assert(
    RUNTIME_SRC.includes("mainFilesystemEnabled && filesystemAccess") &&
      RUNTIME_SRC.includes('name: "postFsToolDocStrip"') &&
      RUNTIME_SRC.includes("blockedToolNamesForAccess(filesystemAccess)"),
    "post-FS strip middleware is keyed on the access policy"
  )
  assert(
    RUNTIME_SRC.includes(
      "...(mainFilesystemEnabled ? [createFsMiddleware()] : []),\n      ...postFsToolDocStripMiddleware,"
    ),
    "post-FS strip runs immediately after the deepagents fs middleware"
  )
}

function testEngineResolvesAndHashesAgentType(): void {
  assert(
    ENGINE_SRC.includes("loadAgentProfiles(context.workspacePath)") &&
      ENGINE_SRC.includes("resolveProfile(request.agentType)"),
    "engine resolves agentType against the run-cached workspace registry"
  )
  assert(
    ENGINE_SRC.includes("agentType: agentProfile?.name ?? null"),
    "the call-identity hash includes the resolved agentType (resume correctness)"
  )
  assert(
    ENGINE_SRC.includes("disallowedTools: agentProfile?.disallowedTools") &&
      ENGINE_SRC.includes("shellAccess: agentProfile?.shellAccess"),
    "engine forwards the resolved tool policy to the runner"
  )
}

function testEnvAwkSafetyBypass(): void {
  // Plain read-only forms stay safe: bare `env`, env-var printing (no command),
  // and `env CMD` WITHOUT assignments.
  for (const ok of ["env", "env FOO=1", "env cat package.json", "awk '{print $1}' f"]) {
    assert(
      assessCommandSafety(ok, "").level === "safe",
      `read-only env/awk should stay safe: ${ok}`
    )
  }
  // `env <cmd>` must be judged by the WRAPPED command, not by `env` being a safe
  // name; awk that can shell out / write files must not be auto-safe.
  for (const bad of [
    "env rm some-file", // env prefix running a mutating command
    "env -i ls", // env flag wrapping a command → review
    // env-var ASSIGNMENT + a command must NOT be auto-approved: the assignment can
    // inject (PATH=/tmp/evil, LD_PRELOAD=…) into an otherwise-safe binary.
    "env FOO=1 ls",
    "env PATH=/x cat f",
    "env LD_PRELOAD=/tmp/x.so cat package.json",
    "env NODE_OPTIONS=--require=/tmp/e.js cat f",
    "awk 'BEGIN{system(\"rm x\")}'", // awk system()
    "awk '{print > \"out\"}'", // awk file write
    "awk '{print | \"sh\"}'", // awk pipe to command
    "awk 'BEGIN{while((getline line < \"/etc/passwd\")>0)print line}'", // awk getline
    "awk -f script.awk f", // external program file (can't inspect)
    // load/include/in-place/write flags must NOT be auto-safe either:
    "awk -i inplace '{print}' file.txt", // gawk in-place edit (writes the file)
    "awk --file script.awk input.txt", // long-form program file
    "awk -l lib.so f", // gawk shared-lib load (native code)
    "awk --load lib.so f",
    "awk --include lib f",
    "awk -E prog.awk f", // exec program file
    "awk -o out.txt prog f", // pretty-print to a file
    "awk -p prof.txt f", // profile output file
    "awk -d vars.out '{print}' f", // gawk dump-variables (writes a file)
    "awk --dump-variables=vars.out '{print}' f",
    // other SAFE_EXECUTABLES with a WRITE / system-change flag (the `-o` letter is
    // output-to-file for these, read-only for ls/grep — see allowed list below):
    "sort input.txt -o output.txt",
    "sort --output=x in.txt",
    "tree -o tree.txt",
    "base64 -o out.txt in.txt",
    "date -s 2020-01-01", // sets the system clock
    "date --set=2020-01-01",
    "diff a.txt b.txt --output=patch.diff",
    // network diagnostics with mutate verbs/flags — read forms (arp -a, route
    // print, netsh … show, ipconfig /all) stay safe in the allowed list below.
    "netsh interface set interface Ethernet admin=disabled",
    "netsh advfirewall set allprofiles state off",
    "netsh winsock reset",
    "netsh exec script.txt", // runs a netsh script file
    "netsh -f script.txt", // -f also runs a netsh script file
    "netsh /f script.txt", // /f slash form
    "netsh -c interface -f script.txt", // -f after a -c context selector
    "route add 0.0.0.0 mask 0.0.0.0 1.2.3.4",
    "route delete 0.0.0.0",
    "route change 10.0.0.0 mask 255.0.0.0 1.2.3.4",
    "route -f", // flush routing table
    "arp -d 192.168.1.1", // delete an ARP entry
    "arp -s 1.2.3.4 aa-bb-cc-dd-ee-ff", // add a static ARP entry
    "ipconfig /flushdns",
    "ipconfig /release",
    "ipconfig /renew",
    "ipconfig /registerdns"
  ]) {
    assert(
      assessCommandSafety(bad, "").level !== "safe",
      `safe-command write/system flag must NOT be auto-safe: ${bad}`
    )
    assert(!isReadOnlyShellCommand(bad, ""), `…and must be blocked in read-only shell: ${bad}`)
  }
  // Read-only forms (incl. the SAME `-o` letter where it's read-only) stay safe.
  for (const ok of [
    "ls -o", // -o here = long format (read-only), NOT output-file
    "grep -o pat f", // -o here = only-matching (read-only)
    "sort -r in.txt", // reverse sort, no output file
    "tree -L 2", // depth limit, no output file
    "base64 -d in.txt", // decode to stdout
    "date -u", // print UTC (read-only)
    "date -d yesterday", // display a date (read-only)
    "awk -F: '{print $1}' f",
    "awk -v x=1 '{print x}' f",
    "awk -F, '{sum+=$2} END{print sum}' data.csv",
    // network diagnostics in their READ form must NOT be false-killed:
    "arp -a", // print the ARP table
    "route print", // print the routing table (Windows)
    "route -n", // print numeric routes (Linux)
    "netsh interface show interface", // show config
    "netsh advfirewall show allprofiles",
    "ipconfig", // print config
    "ipconfig /all", // print full config
    "netstat -an" // unaffected sibling diagnostic
  ]) {
    assert(assessCommandSafety(ok, "").level === "safe", `read-only awk should stay safe: ${ok}`)
    assert(isReadOnlyShellCommand(ok, ""), `read-only diagnostic must stay allowed: ${ok}`)
  }
}

function testConcurrencyWriteFlagExclusive(): void {
  // A write/system-change flag must make the command EXCLUSIVE in the concurrency
  // classifier too — not just needs_approval. tree/diff are in
  // PARALLEL_SAFE_EXECUTABLES, so without the hasUnsafeWriteFlag guard their
  // output-file forms would overlap other shared ops and clobber state. (sort/
  // base64/date/network commands already fall through to exclusive, but the guard
  // covers them uniformly and keeps concurrency in lockstep with the approval gate.)
  for (const bad of [
    "tree -o tree.txt",
    "diff a.txt b.txt --output=patch",
    "base64 -o out.txt in.txt",
    "sort in.txt -o out.txt",
    "date -s 2020-01-01",
    "route add 0.0.0.0 mask 0.0.0.0 1.2.3.4",
    "arp -d 192.168.1.1",
    "netsh interface set interface Ethernet admin=disabled",
    "ipconfig /flushdns"
  ]) {
    assert(
      classifyCommandConcurrency(bad) === "exclusive",
      `write/system-change flag must run exclusively: ${bad}`
    )
  }
  // Their read forms (same executables) stay parallel_safe — no false serialization.
  for (const ok of ["tree -L 2", "diff a.txt b.txt", "base64 -d in.txt", "cat x", "grep p f"]) {
    assert(
      classifyCommandConcurrency(ok) === "parallel_safe",
      `read-only form must stay parallel_safe: ${ok}`
    )
  }
}

function testReadOnlyShellGate(): void {
  // isReadOnlyShellCommand is STRICTER than assessCommandSafety's "safe": it must
  // BLOCK build/install/codegen (they write the tree / run arbitrary code) while
  // NOT false-killing genuine read-only commands — including the build tools'
  // own inspection subcommands.

  // 1) WRITE/EXEC build commands that assessCommandSafety calls "safe" must now
  //    be BLOCKED in a read-only shell (the whole point of the fix).
  for (const blocked of [
    "npm install",
    "npm i",
    "npm ci",
    "npm install left-pad",
    "npm run build",
    "npm test",
    "npm start",
    "yarn add left-pad",
    "pnpm install",
    "bun install",
    "cargo build",
    "cargo test",
    "cargo run",
    "cargo check",
    "go build",
    "go run main.go",
    "go install ./...",
    "go get example.com/x",
    "go generate ./...",
    "go test ./...",
    "go mod tidy",
    "go mod download",
    "go env -w GOFLAGS=-mod=mod",
    "go env -w=true GOX=1", // -w=value form
    "go env --w GOFLAGS=x", // double-dash alias
    "go env --u GOPROXY", // -u unset (double-dash)
    "make",
    "make all",
    "make build",
    "make -n", // dry-run still PARSES the Makefile → evaluates $(shell …)
    "make --dry-run",
    "make -p", // print database — also parses the Makefile
    "make -q", // question — also parses
    "cmake --build .",
    "cmake -S . -B build",
    "javac Main.java",
    "java -jar app.jar",
    "java Main",
    "mvn package",
    "mvn clean install",
    "mvn test",
    // read goals turned WRITE by a flag that allNonFlagArgsMatch would ignore:
    "mvn dependency:tree -DoutputFile=deps.txt",
    "mvn dependency:list -Dmdep.outputFile=x",
    "gradle build",
    "gradle assemble",
    "gradlew test",
    "gradle dependencies --write-locks",
    "gradle dependencies --write-verification-metadata",
    "dotnet build",
    "dotnet run",
    "dotnet test",
    "npm audit fix", // read-only `audit` EXCEPT the writing `fix` variant…
    "npm audit --fix", // …in BOTH subcommand and flag form
    "npm audit --force --fix", // …even after other flags
    "npm audit --fix=true",
    "pnpm audit --fix",
    // `env` is a TRANSPARENT prefix: `env CMD` runs CMD, which assessCommandSafety
    // judges recursively — so `env npm install` is "safe" but must still be
    // blocked (the gate unwraps env, not just looks at tokens[0]).
    "env npm install",
    // PATH-QUALIFIED executables: basename matches a safe name but the binary's
    // identity isn't the known system command → must NOT pass the read-only gate.
    "./ls",
    "/tmp/evil/ls",
    "./git status",
    "/usr/bin/cat package.json",
    "/usr/bin/env ls", // path-qualified env is rejected too
    "./gradlew dependencies" // project script = arbitrary code, even for a read goal
  ]) {
    // sanity: these were "safe" before — confirm the fix targets the safe tier.
    assert(
      assessCommandSafety(blocked, "").level === "safe",
      `precondition: "${blocked}" is auto-approve safe (so the read-only gate is what blocks it)`
    )
    assert(
      !isReadOnlyShellCommand(blocked, ""),
      `read-only shell must BLOCK build/install/exec: ${blocked}`
    )
  }

  // A bare package-manager invocation (yarn/pnpm/bun = install) isn't even
  // auto-approve "safe" (it needs a subcommand to qualify), so it's already
  // blocked upstream — confirm the read-only gate keeps it blocked regardless.
  for (const bare of ["yarn", "pnpm", "bun"]) {
    assert(!isReadOnlyShellCommand(bare, ""), `bare ${bare} (= install) must be blocked`)
  }

  // `env VAR=val CMD` (assignment + command) is now blocked at BOTH layers: the
  // assignment can inject (PATH/LD_PRELOAD/NODE_OPTIONS …) so it's no longer
  // auto-approve "safe", and the read-only gate rejects it too. (Bare `env`/
  // `env CMD` without assignments stays in the allowed list below.)
  for (const envAssign of [
    "env FOO=1 npm install",
    "env BAR=baz cargo build",
    "env PATH=/tmp/evil ls",
    "env LD_PRELOAD=/tmp/e.so cat x",
    "env NODE_OPTIONS=--require=/tmp/e.js cat x",
    "env FOO=1 npm ls"
  ]) {
    assert(
      assessCommandSafety(envAssign, "").level !== "safe",
      `env-assignment must NOT be auto-approve safe: ${envAssign}`
    )
    assert(!isReadOnlyShellCommand(envAssign, ""), `env-assignment must be blocked: ${envAssign}`)
  }

  // 1b) Build/write tunneled through a nested shell must be blocked. On Windows
  //     the safe-command parser treats `powershell -Command "<x>"` as auto-"safe",
  //     so it's re-validated by parsing the inner command; bash/cmd/sh aren't
  //     auto-"safe" anywhere. (On non-Windows ALL of these are blocked at the base
  //     safe bar — powershell/bash/sh/cmd aren't safe executables there.)
  for (const wrapped of [
    'powershell -Command "npm install"',
    'powershell -Command "Remove-Item x"',
    'pwsh -c "cargo build"',
    "bash -c 'npm install'",
    'sh -c "rm -rf node_modules"',
    "cmd /c npm install"
  ]) {
    assert(
      !isReadOnlyShellCommand(wrapped, ""),
      `read-only shell must BLOCK a build/write tunneled through a sub-shell: ${wrapped}`
    )
  }
  // Windows-only: the powershell wrapper is re-validated by parsing its INNER
  // command — read inners stay allowed, build/write inners are blocked. Skipped
  // off Windows because isReadOnlyWindowsCommand only fires on win32 (powershell
  // isn't auto-"safe" elsewhere, so the base bar already blocks the wrapper).
  if (process.platform === "win32") {
    for (const psBlocked of [
      'powershell -Command "npm install"',
      'pwsh -c "cargo build"',
      'powershell -Command "Remove-Item x"'
    ]) {
      assert(
        assessCommandSafety(psBlocked, "").level === "safe" || psBlocked.includes("Remove-Item"),
        `precondition (win32): powershell-wrapped build is auto-approve safe: ${psBlocked}`
      )
      assert(
        !isReadOnlyShellCommand(psBlocked, ""),
        `win32: powershell-wrapped build/write must be blocked: ${psBlocked}`
      )
    }
    // The fix's whole point: powershell-wrapped READ commands must stay allowed
    // (no false-kill of PowerShell inspection).
    for (const psAllowed of [
      'powershell -Command "Get-Content package.json"',
      'powershell -Command "Get-ChildItem"',
      'powershell -Command "npm ls"',
      'pwsh -c "go list ./..."'
    ]) {
      assert(
        isReadOnlyShellCommand(psAllowed, ""),
        `win32: powershell-wrapped read must be ALLOWED: ${psAllowed}`
      )
    }
    // #4 fix: BARE PowerShell read cmdlets are recognized only when the gate is
    // told the shell is PowerShell. With "powershell" they're allowed; with the
    // default "unknown" they're (still) blocked — which is why threading the real
    // shellKind matters on Windows.
    for (const bareRead of [
      "Get-Content package.json",
      "Get-ChildItem",
      "Select-String foo *.ts"
    ]) {
      assert(
        isReadOnlyShellCommand(bareRead, "", "powershell"),
        `win32: bare PS read cmdlet allowed with shellKind=powershell: ${bareRead}`
      )
      assert(
        !isReadOnlyShellCommand(bareRead, "", "unknown"),
        `win32: bare PS read cmdlet still blocked with shellKind=unknown: ${bareRead}`
      )
    }
    // A bare PS WRITE cmdlet must stay blocked even with shellKind=powershell.
    assert(
      !isReadOnlyShellCommand("Remove-Item foo", "", "powershell"),
      "win32: bare PS write cmdlet blocked even with shellKind=powershell"
    )
    // Compound must NOT tunnel through the PowerShell path: both halves must be read.
    assert(
      !isReadOnlyShellCommand("Get-Content x; npm install", "", "powershell"),
      "win32: compound with a non-read half is blocked even under powershell"
    )
  }

  // 1c) PowerShell env-secret exfil: the `Env:` provider lets a read cmdlet print
  //     environment variables (`Get-ChildItem Env:`, `Get-Content Env:OPENAI_API_KEY`),
  //     and `$env:`/`${env:…}` expand them inline. isReadOnlyPowerShellCommand must
  //     reject any token referencing the env provider/variable. Tested DIRECTLY because
  //     it takes pre-parsed words and does not gate on process.platform (unlike
  //     isReadOnlyWindowsCommand), so this runs on every OS.
  for (const psEnvLeak of [
    ["Get-ChildItem", "Env:"], // dump ALL env vars
    ["gci", "Env:"], // alias
    ["dir", "env:"], // alias + lowercase provider
    ["ls", "Env:"], // alias
    ["Get-Item", "Env:OPENAI_API_KEY"], // single var
    ["gi", "Env:OPENAI_API_KEY"], // alias
    ["Get-ItemProperty", "Env:OPENAI_API_KEY"],
    ["gp", "Env:OPENAI_API_KEY"], // alias
    ["Get-Content", "Env:OPENAI_API_KEY"], // read a single var's value
    ["gc", "Env:OPENAI_API_KEY"], // alias
    ["cat", "Env:OPENAI_API_KEY"], // alias
    ["type", "Env:OPENAI_API_KEY"], // alias
    ["echo", "$env:OPENAI_API_KEY"], // $env: variable form
    ["Write-Output", "$env:OPENAI_API_KEY"],
    ["echo", "${env:OPENAI_API_KEY}"], // ${env:…} form
    // PowerShell's documented colon-bound parameter syntax (-Param:Value) must not
    // smuggle the provider past a start-anchored check — real syntax, not edge cases.
    ["Get-Content", "-Path:Env:OPENAI_API_KEY"],
    ["Get-Item", "-Path:Env:OPENAI_API_KEY"],
    ["Get-ChildItem", "-Path:Env:"], // colon-bound, dumps all
    ["Get-Content", "-LiteralPath:Env:OPENAI_API_KEY"],
    ["Get-Content", "-LP:Env:OPENAI_API_KEY"], // -LP alias for -LiteralPath
    ["Get-Content", "-PSPath:Env:OPENAI_API_KEY"], // -PSPath alias
    // A path parameter bound to the Env: provider leaks on ANY cmdlet, not just the
    // content-readers — e.g. Select-String reading a var's value as a "file".
    ["Select-String", "-Path:Env:OPENAI_API_KEY", "secret"], // colon-bound
    ["Select-String", "-Path", "Env:OPENAI_API_KEY", "secret"], // space-separated
    ["Select-String", "-LiteralPath", "Env:OPENAI_API_KEY", "x"] // space, -LiteralPath
  ]) {
    assert(
      !isReadOnlyPowerShellCommand(psEnvLeak),
      `PowerShell env-secret exfil must be blocked: ${psEnvLeak.join(" ")}`
    )
  }
  // No over-block: ordinary PowerShell reads (no env: provider) stay allowed. Includes
  // the literal-`env:` cases that a blanket `\benv:` rule would false-kill — a search
  // pattern or output string containing `env:` is NOT environment-variable access, and
  // `environment.config` (no `env:` provider token at all) must also pass.
  for (const psOk of [
    ["Get-Content", "package.json"],
    ["Get-ChildItem", "C:\\src"],
    ["Get-Content", "environment.config"],
    ["echo", "hello"],
    ["Select-String", "foo", "*.ts"],
    ["Select-String", "env:", "*.txt"], // grep for the literal text "env:" in files
    ["Write-Output", "foo env: bar"], // print a string that merely contains "env:"
    ["Select-String", "env:OPENAI", "config.ps1"], // auditing code for env: usage
    ["Get-Content", "env-notes.txt"], // a filename that starts with "env" but has no colon
    ["Select-String", "env:", "-Path", "*.txt"], // pattern "env:" but -Path points at *.txt, not Env:
    // pure-output cmdlets print args verbatim — a literal that merely LOOKS like a path
    // parameter or the provider is text, not a leak (no $env: expansion is involved):
    ["Write-Output", "-Path:Env:OPENAI_API_KEY"],
    ["echo", "-Path:Env:OPENAI_API_KEY"],
    ["Write-Host", "the Env: drive holds vars"]
  ]) {
    assert(
      isReadOnlyPowerShellCommand(psOk),
      `ordinary PowerShell read must stay allowed (no env: over-block): ${psOk.join(" ")}`
    )
  }

  // 2) Genuine read-only commands must stay ALLOWED — no false-kills. This is the
  //    user's hard constraint: ordinary inspection AND build-tool read subcommands.
  for (const ok of [
    // ordinary read-only shell (never touch a build tool)
    "ls",
    "ls -la src",
    "cat package.json",
    "head -n 20 go.mod",
    "tail README.md",
    "find . -name '*.ts'",
    "rg TODO",
    "grep -r foo src",
    "wc -l file.txt",
    "git log --oneline",
    "git diff HEAD~1",
    "git status",
    "git show HEAD",
    // build-tool INSPECTION subcommands (must NOT be false-killed)
    "npm ls",
    "npm list --depth=0",
    "npm outdated",
    "npm view react version",
    "npm why left-pad",
    "npm audit", // the report itself is read-only (only `--fix` writes)
    "npm audit --json",
    "npm --version",
    "go list ./...",
    "go list -m all",
    "go version",
    "go doc fmt.Println",
    "go env -json", // read-only env flags stay allowed (only -w/-u write)
    "go env -changed",
    "go mod graph",
    "go mod why example.com/x",
    "go env",
    "cargo tree",
    "cargo metadata --no-deps",
    "cargo --version",
    "mvn dependency:tree",
    "mvn dependency:tree -o", // benign flag (offline) — not an output-file flag
    "mvn dependency:list",
    "mvn -version",
    "gradle dependencies",
    "gradle dependencies --offline", // benign flag — not a --write-* flag
    "gradle tasks",
    "gradle --version",
    "dotnet list package",
    "dotnet --version",
    "make --version", // make: ONLY version/help is read-only (-n/-p/-q parse the Makefile)
    "java -version",
    "javac --version",
    // env-wrapped READS must stay allowed — but only WITHOUT assignments (`env CMD`
    // / bare `env`). Assignment forms (`env FOO=1 …`) are rejected as writers above.
    "env ls",
    "env npm ls",
    "env cat package.json"
  ]) {
    assert(isReadOnlyShellCommand(ok, ""), `read-only shell must ALLOW inspection: ${ok}`)
  }

  // 3) Compound / redirected commands are rejected upstream by "safe", so the
  //    gate never has to split them: `ls && npm install` must be blocked.
  for (const compound of ["ls && npm install", "cat x > y", "go list | head", "echo hi; rm x"]) {
    assert(
      !isReadOnlyShellCommand(compound, ""),
      `compound/redirected command must be blocked: ${compound}`
    )
  }

  // 4) Wiring: both read-only execute gates call isReadOnlyShellCommand (not the
  //    plain "safe" check that let build tools through).
  assert(
    RUNTIME_SRC.includes(
      '!isReadOnlyShellCommand(input.command, input.cwd ?? "", windowsShellKind)'
    ) && RUNTIME_SRC.includes('!isReadOnlyShellCommand(command, "", windowsShell)'),
    "both read-only execute gates use isReadOnlyShellCommand"
  )
  // 5) Defense-in-depth: LocalSandbox re-checks the EFFECTIVE (post-hook) command
  //    so a PreToolUse hook can't rewrite a read-only command into a build/write
  //    one, and the runtime sets that flag for read-only runtimes.
  assert(
    LOCAL_SANDBOX_SRC.includes("!isReadOnlyShellCommand(") &&
      LOCAL_SANDBOX_SRC.includes("effectiveCommand,") &&
      LOCAL_SANDBOX_SRC.includes("this.readOnlyShellEnforced"),
    "LocalSandbox enforces read-only on the post-hook effective command"
  )
  // LocalSandbox threads the sandbox's Windows shell kind into the gate so PS
  // read-only cmdlets aren't false-blocked (parity with its assessCommandSafety).
  assert(
    LOCAL_SANDBOX_SRC.includes('this.windowsSandbox !== "none" ? "powershell" : "unknown"'),
    "LocalSandbox passes the derived windows shell kind to the read-only gate"
  )
  assert(
    RUNTIME_SRC.includes("backend.setReadOnlyShellEnforced(true)"),
    "runtime marks read-only runtimes' sandbox for effective-command enforcement"
  )
  // #4: runtime derives the windows shell kind from the sandbox and threads it
  // into createDeepAgent → the guard + customExecute read-only gates.
  assert(
    RUNTIME_SRC.includes(
      'process.platform === "win32" && windowsSandbox !== "none" ? "powershell" : "unknown"'
    ) && RUNTIME_SRC.includes("windowsShellKind"),
    "runtime threads the windows shell kind into the read-only gate"
  )
  // Solo registry subagents share the main (non-flagged) sandbox, so their guard
  // runs the read-only execute call inside readOnlyShellExecutionContext — that's
  // what turns on the post-hook gate for them. LocalSandbox ORs the context with
  // the instance flag.
  assert(
    RUNTIME_SRC.includes("readOnlyShellExecutionContext.run(true, () => handler(request))"),
    "Solo read-only guard runs execute inside the read-only execution context"
  )
  assert(
    LOCAL_SANDBOX_SRC.includes("readOnlyShellExecutionContext.getStore() === true"),
    "LocalSandbox honors the per-call read-only execution context"
  )
}

function testReadOnlyPowerShellCommandClassifier(): void {
  // Cross-platform (no win32 guard on this inner validator) so it runs on macOS
  // CI too — the win32-only isReadOnlyShellCommand path can't be exercised here.
  // The key hole: a PowerShell SCRIPT BLOCK (`% { … }`) can carry arbitrary code
  // behind a read-only outer cmdlet, so it must be rejected.
  const block = [
    ["%", "{", "npm", "install", "}"], // ForEach-Object alias + install in a block
    ["foreach-object", "{", "rm", "x", "}"],
    ["where-object", "{", "Remove-Item", "$_", "}"],
    ["%", "{", "./tool.exe", "}"], // run a project-local binary
    ["%", "{", "node", "-e", "code", "}"], // dynamic execution
    ["%", "{", "iex", "code", "}"],
    ["%", "{npm", "install}"], // braces attached to tokens
    ["Remove-Item", "x"], // side-effecting cmdlet
    ["npm", "install"], // build/write
    ["./gradlew", "dependencies"] // path-qualified
  ]
  for (const w of block) {
    assert(!isReadOnlyPowerShellCommand(w), `read-only PS classifier must REJECT: ${w.join(" ")}`)
  }
  const allow = [
    ["Get-Content", "x"],
    ["Get-ChildItem"],
    ["Select-String", "foo", "*.ts"],
    ["Where-Object", "Name", "-eq", "x"], // simple (non-block) filter form stays OK
    ["npm", "ls"],
    ["go", "list", "./..."],
    ["git", "status"]
  ]
  for (const w of allow) {
    assert(isReadOnlyPowerShellCommand(w), `read-only PS classifier must ALLOW: ${w.join(" ")}`)
  }

  // The AUTO-APPROVE classifier (isSafePowerShellCommand, used by the normal,
  // non-read-only path) must ALSO reject script blocks — otherwise a normal agent
  // auto-runs `Get-Content x | % { rm y }` with no approval prompt.
  for (const w of [
    ["%", "{", "rm", "y", "}"],
    ["foreach-object", "{", "npm", "install", "}"],
    ["where-object", "{", "Remove-Item", "$_", "}"]
  ]) {
    assert(
      !isSafePowerShellCommand(w),
      `auto-approve PS classifier must NOT auto-approve a script block: ${w.join(" ")}`
    )
  }
  for (const w of [
    ["Get-Content", "x"],
    ["Where-Object", "Name", "-eq", "x"]
  ]) {
    assert(
      isSafePowerShellCommand(w),
      `auto-approve PS classifier keeps simple read forms: ${w.join(" ")}`
    )
  }
}

function testDeferredInventoryGatedOnBridge(): void {
  // The `<deferred-tool-ids>` inventory tells the model which deferred (lazy MCP /
  // saved code-exec) tools exist so it can invoke them via the deferred bridge. A
  // restricted leaf (read_only/none registry agent) has the bridge
  // (search/inspect/invoke_deferred) removed but is NOT an
  // isConstrainedCoordinatorWorker, so deferredToolIds still populates — listing
  // tools it can't invoke is misleading. The render must be gated on the invoke
  // bridge being present.
  // (a) the render fn itself: non-empty → block, empty → "".
  const block = renderAvailableDeferredToolsPrompt(["beta", "alpha"])
  assert(block.includes("<deferred-tool-ids>"), "renders the inventory for non-empty ids")
  assert(
    block.indexOf("alpha") < block.indexOf("beta"),
    "inventory ids are sorted (alpha before beta)"
  )
  assert(renderAvailableDeferredToolsPrompt([]) === "", "empty ids → no inventory block")
  // (b) wiring: the runtime gates the inventory render on hasInvokeDeferredTool so
  //     a bridge-less restricted leaf never sees IDs it can't use.
  assert(
    RUNTIME_SRC.includes(
      "if (hasInvokeDeferredTool) {\n      systemPrompt += renderAvailableDeferredToolsPrompt(deferredToolIds)"
    ),
    "runtime gates the deferred-tool inventory on the invoke bridge being available"
  )
}

function testReadOnlyBuildToolInvocationShared(): void {
  // The shared classifier is the single source of truth used by BOTH the POSIX
  // gate (exec-policy isReadOnlyShellCommand) and the Windows/PowerShell gate
  // (windows-safe-commands isReadOnlyPowerShellCommand). Test it directly so the
  // read/write split has cross-platform coverage even when the Windows path is
  // skipped off win32. Callers pass an already-normalized executable + token list.
  const ro = (cmd: string): boolean => {
    const tokens = cmd.split(/\s+/)
    return isReadOnlyBuildToolInvocation(normalizeBuildToolExecutable(tokens[0]), tokens)
  }
  for (const yes of [
    "npm ls",
    "npm outdated",
    "npm --version",
    "go list ./...",
    "go version",
    "go mod graph",
    "go env",
    "go env -json",
    "go env -changed",
    "npm audit",
    "cargo tree",
    "cargo metadata",
    "mvn dependency:tree",
    "gradle dependencies",
    "make --version",
    "dotnet list package",
    "java -version"
  ]) {
    assert(ro(yes), `shared classifier: inspection invocation must be read-only: ${yes}`)
  }
  for (const no of [
    "npm install",
    "npm test",
    "go build",
    "go run main.go",
    "go mod tidy",
    "go env -w X=Y",
    "go env -w=true X=1",
    "go env --w X=Y",
    "go env --u GOPROXY",
    "cargo build",
    "mvn package",
    "mvn dependency:tree -DoutputFile=deps.txt", // write flag (else ignored by allNonFlagArgsMatch)
    "gradle build",
    "gradle dependencies --write-locks",
    "make",
    "make -n", // parses Makefile → can run $(shell …)
    "make -p",
    "make -q",
    "dotnet build",
    "javac Main.java",
    "java -jar app.jar",
    "npm audit fix",
    "npm audit --fix",
    "npm audit --force --fix",
    "pnpm audit --fix",
    // CODE-EXECUTION flags on otherwise read-only build subcommands: an init/
    // build/settings script, an extension JAR, or a vet/tool binary all run
    // arbitrary code, so the inspection subcommand must NOT stay read-only.
    "gradle -I/tmp/evil.gradle tasks", // -I init-script (attached)
    "gradle --init-script=/tmp/evil.gradle tasks",
    "gradle -bbuild.gradle tasks", // -b build-file (attached)
    "gradle -b /tmp/x.gradle tasks",
    "gradle -c /tmp/x.settings tasks", // -c settings-file
    "gradle -p /tmp/x dependencies", // -p project-dir
    "gradle -g /tmp/home tasks", // -g gradle-user-home
    "gradle --include-build /tmp/x dependencies",
    "mvn -Dmaven.ext.class.path=/tmp/evil.jar dependency:tree", // extension JAR
    "mvn -f/tmp/pom.xml dependency:tree", // alternate POM (attached, absolute)
    "mvn -fpom.xml dependency:tree", // attached RELATIVE pom (was leaking)
    "mvn -fsub/pom.xml dependency:tree",
    "mvn -s/tmp/s.xml dependency:tree", // alternate settings (attached)
    "mvn --global-settings=/tmp/g.xml dependency:tree",
    "go vet -vettool=/tmp/evil ./...",
    "go vet -vettool /tmp/evil ./...", // space form (go branch returns on sub alone)
    "go vet --vettool=/tmp/evil ./...", // DOUBLE-dash (go flag pkg: -x == --x)
    "go vet --vettool /tmp/evil ./...",
    "go vet -toolexec=/tmp/evil ./...",
    "go list -toolexec=/tmp/evil ./...",
    "go list --toolexec=/tmp/evil ./...",
    "go list --exec=/tmp/evil ./...",
    "go list -overlay=/tmp/o.json ./...",
    "go list --overlay=/tmp/o.json ./...",
    // gradle/mvn flags that ADD writes/network on an otherwise-read task:
    "gradle dependencies --profile", // writes an HTML profile report
    "gradle tasks --profile",
    "gradle dependencies --scan", // publishes a build scan (network/external)
    "gradle --scan dependencies",
    "gradle dependencies --refresh-dependencies", // re-download (network + cache write)
    "mvn help:effective-pom -Doutput=out.xml", // help plugin WRITES the file
    "mvn help:effective-settings -Doutput=x",
    "mvn dependency:tree -Doutput=deps.txt"
  ]) {
    assert(!ro(no), `shared classifier: build/write invocation must be blocked: ${no}`)
  }
  // The read flags that LOOK similar must NOT be false-killed (esp. gradle -i info
  // vs -I init-script — case matters; mvn -fae/-ff/-fn fail modes vs -f file).
  for (const yes2 of [
    "gradle -i dependencies", // -i info (lowercase) ≠ -I init-script
    "gradle --info tasks",
    "gradle -q dependencies",
    "gradle -s tasks", // -s stacktrace ≠ settings-file (that's -c)
    "mvn -fae dependency:tree", // fail-at-end ≠ -f file
    "mvn -ff dependency:tree",
    "mvn -fn dependency:tree",
    "mvn dependency:tree --offline",
    "go list -json ./...",
    "go vet ./...",
    "gradle dependencies --no-scan", // --no-scan disables scan ≠ --scan
    "gradle dependencies -q",
    "mvn dependency:tree -DoutputType=text" // outputType → stdout (read-only) ≠ -Doutput=<file>
  ]) {
    assert(ro(yes2), `shared classifier: similar read-only flag must survive: ${yes2}`)
  }
  // .cmd/.exe/path forms normalize to the bare tool name (Windows wrappers).
  // (Use a forward-slash path: POSIX path.basename only splits on "/", so a
  // backslash path can't be exercised cross-platform here.)
  assert(
    normalizeBuildToolExecutable("/usr/local/bin/npm") === "npm",
    "normalizeBuildToolExecutable strips a directory path"
  )
  assert(
    normalizeBuildToolExecutable("npm.cmd") === "npm" &&
      BUILD_TOOL_EXECUTABLES.has(normalizeBuildToolExecutable("gradlew.bat")),
    "normalizeBuildToolExecutable strips the .cmd/.bat extension"
  )
  assert(
    isReadOnlyBuildToolInvocation(normalizeBuildToolExecutable("npm.cmd"), ["npm.cmd", "ls"]),
    "npm.cmd ls normalizes to a read-only npm invocation"
  )
  assert(
    !isReadOnlyBuildToolInvocation(normalizeBuildToolExecutable("npm.cmd"), ["npm.cmd", "install"]),
    "npm.cmd install normalizes to a blocked npm invocation"
  )
}

function testOversizedAgentFileSkipped(): void {
  // An oversized agent markdown is skipped (not loaded) so it can't bloat registry
  // load / memory / the injected prompt. A normal-sized sibling still loads.
  const ws = makeWorkspace({
    "big.md": `---\nname: big\ndescription: x\n---\n${"A".repeat(300 * 1024)}`,
    "ok.md": `---\nname: ok\ndescription: x\n---\nbody`
  })
  try {
    const profs = loadAgentProfiles(ws)
    assert(!profs.some((p) => p.name === "big"), "oversized agent file (>256KB) is skipped")
    assert(
      profs.some((p) => p.name === "ok"),
      "a normal-sized agent file still loads (one big file doesn't break the registry)"
    )
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

function testQualifiedBashDoesNotGrantFullShell(): void {
  // CC `Bash(git log:*)` qualifier restricts a command prefix. We can't enforce
  // command-level prefixes, so a qualified-only Bash must NOT become full shell —
  // it downgrades to read_only. Plain Bash stays full.
  const ws = makeWorkspace({
    "q.md": `---\nname: q\ntools: Read, Bash(git log:*)\n---\nbody`,
    "qmix.md": `---\nname: qmix\ntools: Read, Bash, Bash(git log:*)\n---\nbody`,
    "plain.md": `---\nname: plain\ntools: Read, Bash\n---\nbody`
  })
  // Also assert no false "unrecognized tool" warning: the qualifier `git log:*`
  // contains a space, so a whitespace-splitting parser would tear it into
  // "Bash(git" + "log:*)" and warn on the latter. parseToolList must split on
  // commas only.
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (...a: unknown[]): void => {
    warnings.push(a.map((x) => String(x)).join(" "))
  }
  try {
    const ps = loadAgentProfiles(ws)
    const q = ps.find((p) => p.name === "q")!
    assert(
      q.shellAccess === "read_only",
      "qualified-only Bash(git log:*) downgrades to read_only, not full"
    )
    const qmix = ps.find((p) => p.name === "qmix")!
    assert(qmix.shellAccess === "full", "an unqualified Bash alongside a qualified one keeps full")
    const plain = ps.find((p) => p.name === "plain")!
    assert(plain.shellAccess === "full", "plain Bash still grants full shell")
    assert(
      !warnings.some((w) => w.includes("log:*") || w.includes("Bash(git")),
      `qualified Bash(git log:*) must not produce a false unrecognized-tool warning, got: ${warnings.join(" | ")}`
    )
  } finally {
    console.warn = origWarn
    rmSync(ws, { recursive: true, force: true })
  }
}

function testStripBlockedToolDocsHandlesObject(): void {
  // langchain ModelRequest.systemMessage is a SystemMessage OBJECT; the strip must
  // work on its .content (the old string-only version silently no-op'd here).
  const content =
    "You are an agent.\n- read_file: read\n- write_file: write\n- edit_file: edit\n\n## Execute Tool\nrun shell\n\n## Keep\nstay"
  const out = stripBlockedToolDocs(
    new SystemMessage({ content }),
    new Set(["write_file", "edit_file", "execute"])
  ) as { content?: unknown }
  assert(out instanceof SystemMessage, "returns a SystemMessage (prototype preserved)")
  const text = String(out.content)
  assert(!text.includes("- write_file:") && !text.includes("- edit_file:"), "blocked docs removed")
  assert(text.includes("- read_file:"), "allowed tool doc kept")
  assert(!text.includes("## Execute Tool"), "execute section removed when execute blocked")
  assert(text.includes("## Keep"), "unrelated sections kept")

  // SystemMessage.content can ALSO be a content-block array (LangChain
  // normalizeSystemPrompt / SystemMessage.concat() produce `[{type:"text",text}]`
  // when deepagents concatenates docs onto a block-array base). The old version
  // only stripped string content → silent no-op on arrays (same leak, other shape).
  const arr = new SystemMessage({
    content: [
      { type: "text", text: "Base.\n- write_file: write\n- edit_file: edit" },
      { type: "text", text: `${content}` }
    ]
  } as never)
  const arrOut = stripBlockedToolDocs(arr, new Set(["write_file", "edit_file", "execute"]))
  assert(
    arrOut instanceof SystemMessage,
    "array content: returns a SystemMessage (prototype preserved)"
  )
  const arrText = JSON.stringify((arrOut as { content: unknown }).content)
  assert(
    !arrText.includes("## Execute Tool") &&
      !arrText.includes("- write_file:") &&
      !arrText.includes("- edit_file:"),
    "array content: blocked docs + execute section removed across blocks"
  )
  assert(arrText.includes("- read_file:"), "array content: allowed tool doc kept")

  // A content-block array with NOTHING to strip returns the SAME reference (no churn).
  const clean = new SystemMessage({ content: [{ type: "text", text: "nothing here" }] } as never)
  assert(
    stripBlockedToolDocs(clean, new Set(["execute"])) === clean,
    "array content with no match returns the same object"
  )
}

function testYamlBlockSequenceTools(): void {
  // CC supports a YAML block sequence for tools; the loader must treat it like
  // the comma/inline-array forms instead of silently falling back to full tools.
  const ws = makeWorkspace({
    "blk.md": `---\nname: blk\ndescription: x\ntools:\n  - Read\n  - Grep\n---\nbody`,
    // block-sequence disallowedTools (denylist) must also take effect
    "blkden.md": `---\nname: blkden\ndescription: x\ndisallowedTools:\n  - Write\n  - Edit\n---\nbody`
  })
  try {
    const blk = loadAgentProfiles(ws).find((p) => p.name === "blk")!
    assert(
      blk.disallowedTools.includes("write_file") &&
        !blk.disallowedTools.includes("read_file") &&
        !blk.disallowedTools.includes("grep"),
      "block-sequence tools parse as an allowlist (NOT silently full tools)"
    )
    assert(blk.shellAccess === "none", "block-sequence allowlist without Bash → no shell")
    const blkden = loadAgentProfiles(ws).find((p) => p.name === "blkden")!
    assert(
      blkden.disallowedTools.includes("write_file") && blkden.disallowedTools.includes("edit_file"),
      "block-sequence disallowedTools (denylist) takes effect"
    )
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

function testYamlCommentsDoNotWidenPolicy(): void {
  // A YAML comment must NOT silently widen a restricted agent to full tools:
  //  - a `# comment` line between `tools:` and its `- item`s previously aborted
  //    the block scan → empty allowlist → fallback to full shell + no denylist;
  //  - an inline comment on a scalar (`workload: read_only # note`) was kept in
  //    the value → ≠ the "read_only" enum → fallback to full.
  const ws = makeWorkspace({
    "cmt.md": `---\nname: cmt\ndescription: x\ntools:\n  # only safe tools\n  - Read\n  - Grep\n---\nbody`,
    "wl.md": `---\nname: wl\ndescription: x\nworkload: read_only # inspect only\n---\nbody`,
    "item.md": `---\nname: item\ndescription: x\ntools:\n  - Read # read only\n  # midblock\n  - Grep\n---\nbody`
  })
  try {
    const cmt = loadAgentProfiles(ws).find((p) => p.name === "cmt")!
    assert(
      cmt.shellAccess === "none" &&
        cmt.disallowedTools.includes("write_file") &&
        !cmt.disallowedTools.includes("read_file"),
      "a comment line before block items must NOT widen the allowlist to full tools"
    )
    const wl = loadAgentProfiles(ws).find((p) => p.name === "wl")!
    assert(
      wl.shellAccess === "read_only",
      "an inline comment on `workload: read_only` must still be read_only (not full)"
    )
    const item = loadAgentProfiles(ws).find((p) => p.name === "item")!
    assert(
      !item.disallowedTools.includes("read_file") && !item.disallowedTools.includes("grep"),
      "inline comments on block items + a midblock comment still parse Read+Grep"
    )
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

function testDisallowedToolsCoversNonFsTools(): void {
  // disallowedTools must be able to name NON-fs tools (MCP bridge, memory,
  // code_exec) — previously they normalized to null and were
  // silently dropped, so a user "denylist" was a no-op. Genuinely unknown names
  // still drop to null (caller warns).
  assert(normalizeToolName("memory_search") === "memory_search", "memory_search recognized")
  assert(normalizeToolName("code_exec") === "code_exec", "code_exec recognized")
  assert(
    normalizeToolName("mcp__node_repl__js") === "mcp__node_repl__js",
    "mcp__node_repl__js recognized"
  )
  assert(
    normalizeToolName("invoke_deferred_tool") === "invoke_deferred_tool",
    "invoke_deferred_tool recognized"
  )
  assert(normalizeToolName("NotebookEdit") === null, "genuinely unknown name still null (warns)")

  const ws = makeWorkspace({
    // a write agent that explicitly denies a deferred/exec tool
    "noweb.md": `---\nname: noweb\ndescription: x\ndisallowedTools: memory_search, code_exec\n---\nbody`
  })
  try {
    const noweb = loadAgentProfiles(ws).find((p) => p.name === "noweb")!
    assert(
      noweb.disallowedTools.includes("memory_search") &&
        noweb.disallowedTools.includes("code_exec"),
      "disallowedTools now actually carries the non-fs tool names (not silently dropped)"
    )
    assert(noweb.shellAccess === "full", "denying memory/code_exec doesn't touch shellAccess")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

function testAllowlistBlocksNonFsSideEffectTools(): void {
  // A `tools:` allowlist now also excludes fixed non-fs SIDE-EFFECT tools
  // (code_exec/deferred bridge/orchestration) not listed — so a `tools: Read,
  // Bash` no longer silently retains the deferred bridge.
  // Read-only memory + eager MCP are intentionally NOT force-blocked by allowlist.
  const ws = makeWorkspace({
    "rb.md": `---\nname: rb\ntools: Read, Bash\n---\nbody`
  })
  try {
    const rb = loadAgentProfiles(ws).find((p) => p.name === "rb")!
    assert(rb.shellAccess === "full", "Bash in allowlist → full shell")
    for (const t of [
      "invoke_deferred_tool",
      "search_tool",
      "inspect_tool",
      "code_exec",
      "save_code_exec_tool",
      "mcp__node_repl__js",
      "manage_scheduler",
      "manage_skill"
    ]) {
      assert(
        rb.disallowedTools.includes(t),
        `allowlist 'Read, Bash' must now block non-listed side-effect tool ${t}`
      )
    }
    assert(
      !rb.disallowedTools.includes("read_file") && !rb.disallowedTools.includes("memory_search"),
      "allowlisted Read survives; read-only memory is NOT force-blocked by an allowlist"
    )
    // task_output is the read-side of execute's background mode: granting Bash must
    // NOT block task_output, else background commands are startable but unreadable.
    assert(
      !rb.disallowedTools.includes("task_output"),
      "allowlist with Bash keeps task_output (background command results stay readable)"
    )
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }

  // Without Bash, task_output IS blocked (no execute → it's useless); an explicit
  // denylist still wins over the execute→task_output grant; a qualified Bash
  // (read_only) still keeps task_output.
  const ws2 = makeWorkspace({
    "nob.md": `---\nname: nob\ntools: Read, Grep\n---\nbody`,
    "den.md": `---\nname: den\ntools: Read, Bash\ndisallowedTools: task_output\n---\nbody`,
    "qb.md": `---\nname: qb\ntools: Read, Bash(git:*)\n---\nbody`
  })
  try {
    const profs = loadAgentProfiles(ws2)
    const nob = profs.find((p) => p.name === "nob")!
    assert(
      nob.shellAccess === "none" && nob.disallowedTools.includes("task_output"),
      "no Bash → task_output blocked (no background execution to read)"
    )
    const den = profs.find((p) => p.name === "den")!
    assert(
      den.disallowedTools.includes("task_output"),
      "explicit disallowedTools: task_output wins over the execute→task_output grant"
    )
    const qb = profs.find((p) => p.name === "qb")!
    assert(
      qb.shellAccess === "read_only" && !qb.disallowedTools.includes("task_output"),
      "qualified Bash (read_only) still keeps task_output"
    )
  } finally {
    rmSync(ws2, { recursive: true, force: true })
  }
}

function testWorkflowApprovalKeyIncludesProfileFingerprint(): void {
  // The workflow "approve for this session" cache key must fold in the agent
  // registry, not just the script text. Otherwise editing .cmbcoworkagent/agents/
  // (e.g. flipping Explore to full-shell) while keeping the same script would
  // reuse the prior approval and launch with the higher-privilege profile.
  assert(
    WORKFLOW_TOOL_SRC.includes("registryFingerprint") &&
      WORKFLOW_TOOL_SRC.includes("loadAgentProfiles(workspacePath)"),
    "workflow launch approval computes a registry fingerprint from loadAgentProfiles"
  )
  assert(
    WORKFLOW_TOOL_SRC.includes("`workflow:launch:${sha256Hex(script)}:${registryFingerprint}") &&
      WORKFLOW_TOOL_SRC.includes("${argsFingerprint}:tb=${tokenBudget ?? "),
    "workflow launch approval key includes script hash + registry fingerprint + args + tokenBudget"
  )
  assert(
    WORKFLOW_TOOL_SRC.includes(
      'const argsFingerprint = sha256Hex(args === undefined ? "undefined" : JSON.stringify(args))'
    ),
    "workflow approval folds in args (changing args re-prompts; undefined vs explicit null distinguished)"
  )
  assert(
    WORKFLOW_TOOL_SRC.includes("input.tokenBudget ?? null") &&
      WORKFLOW_TOOL_SRC.includes("tokenBudget: number | null"),
    "workflow approval also folds in tokenBudget (raising the budget re-prompts)"
  )
  assert(
    WORKFLOW_TOOL_SRC.includes("const argsPreview ="),
    "approval card computes an args preview (so the user can see what the run targets)"
  )
  // The frontend approval card must actually RENDER the workflow preview the
  // backend sends — otherwise scriptPreview/argsPreview are dead data and a
  // workflow approval falls through to the generic "command" card showing nothing.
  assert(
    CHAT_CONTAINER_SRC.includes('pendingApproval.tool_call?.name === "workflow"'),
    "frontend detects the workflow launch approval"
  )
  assert(
    CHAT_CONTAINER_SRC.includes("workflowArgs.scriptPreview") &&
      CHAT_CONTAINER_SRC.includes("workflowArgs.argsPreview") &&
      CHAT_CONTAINER_SRC.includes("workflowPhases"),
    "frontend workflow approval renders script/args/phases preview"
  )
  assert(
    WORKFLOW_TOOL_SRC.includes("disallowedTools: [...p.disallowedTools].sort()") &&
      WORKFLOW_TOOL_SRC.includes("shellAccess: p.shellAccess"),
    "registry fingerprint folds in each profile's tool policy (sorted disallowedTools + shellAccess)"
  )
  assert(
    WORKFLOW_TOOL_SRC.includes("model: p.model ?? null"),
    "registry fingerprint also folds in profile model (feeds resolvedModel — changing it must re-approve)"
  )
  // TOCTOU guard: the fingerprint is recomputed AFTER the approval await and
  // compared to the pre-prompt value, failing closed if the agent registry
  // changed while the dialog was open (so an approval can't apply to a different
  // profile than it was shown for). It must re-load (a captured snapshot wouldn't
  // detect a mid-approval edit), so the helper is invoked a second time.
  assert(
    WORKFLOW_TOOL_SRC.includes("const computeRegistryFingerprint = ()") &&
      WORKFLOW_TOOL_SRC.includes("computeRegistryFingerprint() !== registryFingerprint"),
    "approval re-checks the registry fingerprint after the prompt (TOCTOU guard)"
  )
}

function testUnknownFrontmatterWarning(): void {
  // CC-only fields (memory/effort/…) aren't supported here; the loader must warn
  // so a user porting a CC agent notices the field had no effect — while still
  // parsing the supported fields on the same file.
  const ws = makeWorkspace({
    "fancy.md": `---\nname: fancy\ndescription: x\nmemory: project\neffort: high\nmodel: opus\n---\nbody`
  })
  const warnings: string[] = []
  const orig = console.warn
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map((a) => String(a)).join(" "))
  }
  try {
    const fancy = loadAgentProfiles(ws).find((p) => p.name === "fancy")!
    assert(fancy.model === "opus", "supported fields still parse alongside unknown ones")
  } finally {
    console.warn = orig
    rmSync(ws, { recursive: true, force: true })
  }
  const joined = warnings.join("\n")
  assert(/field "memory"/.test(joined), "warns on unsupported field memory")
  assert(/field "effort"/.test(joined), "warns on unsupported field effort")
  assert(
    !/field "model"/.test(joined) && !/field "name"/.test(joined),
    "no warning for supported fields (name/model)"
  )
}

const tests = [
  testBuiltInsPresent,
  testBuiltInPromptParity,
  testWriteToolNames,
  testCcToolNameMapping,
  testWorkloadShortcut,
  testFrontmatterFieldsCaseInsensitive,
  testCcStyleToolsFrontmatter,
  testLoadUserAgentDefaults,
  testUserOverridesBuiltIn,
  testUserOverridesBuiltInCaseInsensitively,
  testResolveUnknown,
  testCaseInsensitiveSurvivesUserOverride,
  testStripBlockedToolDocs,
  testCoordinatorReadOnlyKeepsExecute,
  testLevel2GatedToSoloMainAgent,
  testLevel2DedupAndMerge,
  testLevel2ToolGuard,
  testSoloTaskDescriptionsExposeAccessPolicy,
  testLevel1ToolPlumbing,
  testWorkflowAgentTypeLeafConfig,
  testLevel2MemoryInjection,
  testRegistryAgentBlockedTools,
  testEnvAwkSafetyBypass,
  testConcurrencyWriteFlagExclusive,
  testReadOnlyShellGate,
  testReadOnlyBuildToolInvocationShared,
  testOversizedAgentFileSkipped,
  testReadOnlyPowerShellCommandClassifier,
  testDeferredInventoryGatedOnBridge,
  testQualifiedBashDoesNotGrantFullShell,
  testStripBlockedToolDocsHandlesObject,
  testYamlBlockSequenceTools,
  testYamlCommentsDoNotWidenPolicy,
  testDisallowedToolsCoversNonFsTools,
  testAllowlistBlocksNonFsSideEffectTools,
  testWorkflowApprovalKeyIncludesProfileFingerprint,
  testUnknownFrontmatterWarning,
  testStripCustomModelPrefix,
  testExecuteAvailabilityGatesBackgroundExecPrompt,
  testPostFsStripRemovesDeepagentsExecuteDoc,
  testEngineResolvesAndHashesAgentType
]

// Isolate HOME so the host machine's ~/.cmbcoworkagent/agents/ global agents can't
// leak into these tests. loadAgentProfiles() reads home + workspace, so a stray
// global agent named e.g. "ghost-agent" or "Explore" would otherwise break the
// unknown/override assertions non-deterministically. tmpdir() is unaffected, so
// makeWorkspace() still creates real workspace agents.
const isolatedHome = mkdtempSync(join(tmpdir(), "cmb-isolated-home-"))
const origHome = process.env.HOME
const origUserProfile = process.env.USERPROFILE
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
try {
  for (const test of tests) {
    test()
  }
  console.log(`PASS agent-registry + wiring (${tests.length} tests)`)
} finally {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  if (origUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = origUserProfile
  rmSync(isolatedHome, { recursive: true, force: true })
}
