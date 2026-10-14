import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { SystemMessage } from "@langchain/core/messages"
import { createSkillsMiddleware } from "deepagents"
import { LocalSandbox } from "./local-sandbox"
import { createClawSkillPolicy, listClawSkillSources } from "../mods/claw-skills"
import { createClawSkillsMiddleware } from "./claw-skills-middleware"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

async function fixture(names = ["allowed"]) {
  const root = mkdtempSync(join(tmpdir(), "claw-skills-prompt-"))
  roots.push(root)
  let disabled: string[] = []
  for (const name of ["allowed", "excluded"]) {
    const dir = join(root, name)
    mkdirSync(dir)
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: FRESH-${name}\n---\nbody`
    )
  }
  const access = {
    sources: async () => [{ sourceDir: root }],
    currentSources: () => [{ sourceDir: root }],
    disabledDirs: () => disabled
  }
  const entries = await listClawSkillSources(access)
  const policy = (await createClawSkillPolicy(
    {
      mode: "selected",
      items: entries.filter((item) => names.includes(item.name))
    },
    access
  ))!
  const backend = new LocalSandbox({ rootDir: root, runId: "claw-skills-prompt" })
  backend.setClawSkillPolicy(policy)
  const options = { backend, sources: policy.middlewareSources }
  const state = {
    skillsMetadata: [
      { name: "excluded", description: "STALE-EXCLUDED", path: join(root, "excluded/SKILL.md") },
      { name: "allowed", description: "STALE-ALLOWED", path: join(root, "allowed/SKILL.md") }
    ]
  }
  return {
    root,
    options,
    policy,
    state,
    disable: () => {
      disabled = [join(root, "allowed")]
    }
  }
}

async function initialize(middleware: ReturnType<typeof createSkillsMiddleware>, state: unknown) {
  if (typeof middleware.beforeAgent !== "function") throw Error("Missing beforeAgent")
  return middleware.beforeAgent(state as never, {} as never)
}

async function prompt(middleware: ReturnType<typeof createSkillsMiddleware>, state: unknown) {
  if (!middleware.wrapModelCall) throw Error("Missing wrapModelCall")
  let text = ""
  await middleware.wrapModelCall(
    { state, systemMessage: new SystemMessage("base") } as never,
    async (request) => {
      text = JSON.stringify(request.systemMessage)
      return {} as never
    }
  )
  return text
}

it("reproduces upstream checkpoint catalog reuse and replaces it with current selected backend discovery", async () => {
  const f = await fixture()
  const original = createSkillsMiddleware(f.options)
  await initialize(original, f.state)
  expect(await prompt(original, f.state)).toContain("STALE-EXCLUDED")
  const guarded = createClawSkillsMiddleware(f.options, f.policy)
  const update = await initialize(guarded, f.state)
  expect(JSON.stringify(update)).toContain("FRESH-allowed")
  const text = await prompt(guarded, f.state)
  expect(text).toContain("FRESH-allowed")
  expect(text).not.toContain("STALE-")
  expect(text).not.toContain("FRESH-excluded")
})

it("does not resurrect checkpoint metadata when the current selection is empty", async () => {
  const f = await fixture([])
  const guarded = createClawSkillsMiddleware(f.options, f.policy)
  await initialize(guarded, f.state)
  const text = await prompt(guarded, f.state)
  expect(text).not.toContain("STALE-")
  expect(text).not.toContain("FRESH-")
})

it.each(["disabled", "changed"] as const)(
  "revalidates %s sources before a later model call",
  async (change) => {
    const f = await fixture()
    const guarded = createClawSkillsMiddleware(f.options, f.policy)
    await initialize(guarded, f.state)
    expect(await prompt(guarded, f.state)).toContain("FRESH-allowed")
    if (change === "disabled") f.disable()
    else writeFileSync(join(f.root, "allowed/SKILL.md"), "changed after discovery")
    await expect(prompt(guarded, f.state)).rejects.toThrow(
      change === "disabled" ? "CLAW_SKILL_DISABLED" : "CLAW_SKILL_SOURCE_CHANGED"
    )
  }
)

it("retains original middleware behavior when there is no Claw skill restriction", async () => {
  const f = await fixture()
  const unchanged = createClawSkillsMiddleware(f.options)
  await initialize(unchanged, f.state)
  expect(await prompt(unchanged, f.state)).toContain("STALE-EXCLUDED")
})

it.each([{ names: [] as string[] }, { names: ["allowed"] }])(
  "does not let a subagent add unregistered discovery sources to selection $names",
  async ({ names }) => {
    const f = await fixture(names)
    const extraRoot = mkdtempSync(join(tmpdir(), "claw-extra-subagent-skills-"))
    roots.push(extraRoot)
    const extraSkill = join(extraRoot, "foreign")
    mkdirSync(extraSkill)
    writeFileSync(
      join(extraSkill, "SKILL.md"),
      "---\nname: foreign\ndescription: FRESH-foreign\n---\nbody"
    )
    const options = { ...f.options, sources: [...f.policy.middlewareSources, extraRoot] }
    // The filesystem may read ordinary files outside registered Skill roots. The
    // middleware must not turn that general access into a new Skill selection.
    const original = createSkillsMiddleware(options)
    await initialize(original, { skillsMetadata: [] })
    expect(await prompt(original, {})).toContain("FRESH-foreign")
    const guarded = createClawSkillsMiddleware(options, f.policy)
    await initialize(guarded, f.state)
    const text = await prompt(guarded, f.state)
    expect(text).not.toContain("FRESH-foreign")
    expect(text).not.toContain("STALE-")
    if (names.length) expect(text).toContain("FRESH-allowed")
    else expect(text).not.toContain("FRESH-")
  }
)
