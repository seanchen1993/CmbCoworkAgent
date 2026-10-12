import { describe, expect, it } from "vitest"
import {
  skillDependencyCheck,
  skillDependencyDeclaration,
  SKILL_DEPENDENCY_MAX_BYTES
} from "../../shared/skill-dependencies"
import { parseSkillDependencies } from "./dependencies"
import { parseSkillFrontmatter, parseSkillFrontmatterChecked } from "./frontmatter"

function markdown(fields: string): string {
  return `---\nname: review\n${fields}\n---\nReview the project.`
}

function native(checks: unknown[], extras: Record<string, unknown> = {}): string {
  return markdown(
    `cmbdevclaw-dependencies: ${JSON.stringify({ schemaVersion: 1, checks, ...extras })}`
  )
}

function openclaw(value: unknown): string {
  return markdown(`metadata: ${JSON.stringify({ openclaw: value })}`)
}

describe("skill dependency declarations", () => {
  it("distinguishes no declaration, free compatibility text and invalid frontmatter", () => {
    expect(parseSkillDependencies("Plain skill instructions.")).toMatchObject({
      source: "none",
      state: "absent",
      checks: [],
      reason: expect.any(String)
    })
    expect(parseSkillDependencies(markdown("compatibility: Requires Node.js 22"))).toMatchObject({
      source: "none",
      state: "unstructured",
      checks: [],
      reason: expect.any(String)
    })
    expect(parseSkillDependencies(markdown("metadata: [unterminated"))).toMatchObject({
      source: "none",
      state: "invalid",
      checks: [],
      reason: expect.any(String)
    })
    expect(parseSkillDependencies("---\nname: incomplete")).toMatchObject({
      state: "invalid",
      checks: []
    })
  })

  it("preserves the original frontmatter return shape and body semantics", () => {
    for (const content of [
      "Plain instructions",
      markdown("description: okay"),
      markdown("bad: ["),
      "---\nname: incomplete"
    ]) {
      const checked = parseSkillFrontmatterChecked(content)
      const previous = { frontmatter: checked.frontmatter, body: checked.body }
      expect(parseSkillFrontmatter(content)).toEqual(previous)
      expect(Object.keys(parseSkillFrontmatter(content)).sort()).toEqual(["body", "frontmatter"])
    }
    expect(parseSkillFrontmatterChecked(markdown("description: okay")).status).toBe("valid")
    expect(parseSkillFrontmatterChecked(markdown("bad: [")).status).toBe("invalid")
  })

  it("reads explicit versioned CMBDevClaw checks without guessing probe commands", () => {
    const checks = [
      { id: "os", kind: "platform", platforms: ["darwin", "win32", "linux"] },
      {
        id: "node",
        kind: "executable",
        name: "node",
        minimumVersion: "22.0.0"
      },
      { id: "python", kind: "any-executable", names: ["python", "python3"] },
      {
        id: "lockfile",
        kind: "file",
        path: "config/package-lock.json",
        type: "file"
      },
      { id: "scripts", kind: "file", path: "scripts", type: "directory" },
      { id: "token", kind: "environment", name: "SERVICE_TOKEN" }
    ]
    expect(parseSkillDependencies(native(checks))).toEqual({
      source: "cmbdevclaw",
      state: "structured",
      checks
    })
    expect(
      parseSkillDependencies(
        native([
          {
            id: "node",
            kind: "executable",
            name: "node",
            probeCommand: "printenv"
          }
        ])
      ).state
    ).toBe("invalid")
    expect(parseSkillDependencies(native(checks, { schemaVersion: 2 })).state).toBe("invalid")
  })

  it("maps OpenClaw declarations with exact all/any semantics and retains unsupported config", () => {
    const declaration = parseSkillDependencies(
      openclaw({
        os: ["darwin"],
        requires: {
          bins: ["git", "node"],
          anyBins: ["python3", "python"],
          env: ["SERVICE_TOKEN"],
          config: ["channels.example.enabled"],
          files: ["secret.txt"]
        },
        primaryEnv: "OPTIONAL_TOKEN",
        always: true,
        install: [{ kind: "node", package: "ignored" }]
      })
    )
    expect(declaration.source).toBe("openclaw")
    expect(declaration.state).toBe("structured")
    expect(declaration.checks.map(({ kind }) => kind)).toEqual([
      "platform",
      "executable",
      "executable",
      "any-executable",
      "environment",
      "unsupported",
      "unsupported"
    ])
    expect(declaration.checks).toContainEqual(
      expect.objectContaining({
        kind: "unsupported",
        label: "requires.config"
      })
    )
    expect(declaration.checks).toContainEqual(
      expect.objectContaining({ kind: "unsupported", label: "requires.files" })
    )
    expect(JSON.stringify(declaration)).not.toContain("secret.txt")
    expect(JSON.stringify(declaration)).not.toContain("OPTIONAL_TOKEN")
    expect(new Set(declaration.checks.map(({ id }) => id)).size).toBe(declaration.checks.length)
  })

  it("accepts nested YAML and explicit JSON metadata scalars and supports the legacy key", () => {
    const yaml = markdown("metadata:\n  openclaw:\n    requires:\n      bins: [git]")
    const scalar = markdown(
      `metadata: '${JSON.stringify({ openclaw: { requires: { bins: ["git"] } } })}'`
    )
    const legacy = markdown(
      `metadata: ${JSON.stringify({ clawdbot: { requires: { bins: ["git"] } } })}`
    )
    for (const content of [yaml, scalar, legacy]) {
      expect(parseSkillDependencies(content)).toMatchObject({
        source: "openclaw",
        state: "structured",
        checks: [expect.objectContaining({ kind: "executable", name: "git" })]
      })
    }
    expect(parseSkillDependencies(markdown("metadata: 'not JSON metadata'")).state).toBe(
      "unstructured"
    )
    expect(
      parseSkillDependencies(markdown("metadata: '{ openclaw: { requires: true } }'")).state
    ).toBe("invalid")
  })

  it("preserves OpenClaw's explicit CSV and member trimming without accepting empty members", () => {
    expect(
      parseSkillDependencies(
        openclaw({
          requires: { bins: " git, node ", env: [" SERVICE_TOKEN "] },
          os: " darwin,linux "
        })
      )
    ).toMatchObject({
      state: "structured",
      checks: [
        expect.objectContaining({
          kind: "platform",
          platforms: ["darwin", "linux"]
        }),
        expect.objectContaining({ kind: "executable", name: "git" }),
        expect.objectContaining({ kind: "executable", name: "node" }),
        expect.objectContaining({ kind: "environment", name: "SERVICE_TOKEN" })
      ]
    })
    expect(parseSkillDependencies(openclaw({ requires: { bins: "git,,node" } })).state).toBe(
      "invalid"
    )
  })

  it("does not verify prose requirements beside structured checks", () => {
    const content = native([{ id: "node", kind: "executable", name: "node" }]).replace(
      "name: review",
      "name: review\ncompatibility: Requires Node.js 22"
    )
    expect(parseSkillDependencies(content).checks).toContainEqual(
      expect.objectContaining({
        id: "compatibility",
        kind: "unsupported",
        label: "compatibility"
      })
    )
  })

  it("uses current OpenClaw key without falling back from a malformed current manifest", () => {
    const declaration = parseSkillDependencies(
      markdown(
        `metadata: ${JSON.stringify({ openclaw: null, clawdbot: { requires: { bins: ["git"] } } })}`
      )
    )
    expect(declaration).toMatchObject({
      source: "openclaw",
      state: "invalid",
      checks: []
    })
  })

  it("merges native and OpenClaw requirements while rejecting identity collisions", () => {
    const content = markdown(
      `cmbdevclaw-dependencies: ${JSON.stringify({ schemaVersion: 1, checks: [{ id: "repo", kind: "file", path: "src", type: "directory" }] })}\nmetadata: ${JSON.stringify({ openclaw: { requires: { bins: ["git"] } } })}`
    )
    const declaration = parseSkillDependencies(content)
    expect(declaration).toMatchObject({ source: "mixed", state: "structured" })
    expect(declaration.checks).toHaveLength(2)
    const importedId = declaration.checks[1].id
    expect(
      parseSkillDependencies(content.replace('"id":"repo"', `"id":"${importedId}"`))
    ).toMatchObject({
      source: "mixed",
      state: "invalid",
      checks: []
    })
  })

  it.each([
    { requires: { bins: 42 } },
    { requires: { bins: ["git", 42] } },
    { requires: { bins: ["git", "git"] } },
    { requires: { bins: ["git", " "] } },
    { requires: { env: ["BAD-NAME"] } },
    { os: ["unknown"] },
    { os: ["darwin", "darwin"] },
    { requires: [] }
  ])("does not discard malformed requirement values: %j", (manifest) => {
    expect(parseSkillDependencies(openclaw(manifest))).toMatchObject({
      source: "openclaw",
      state: "invalid",
      checks: []
    })
  })

  it("keeps an empty declaration unverified rather than claiming no dependencies are needed", () => {
    for (const content of [
      native([]),
      openclaw({ requires: {} }),
      openclaw({ requires: { bins: [] } }),
      openclaw({ emoji: "X" })
    ]) {
      expect(parseSkillDependencies(content)).toMatchObject({
        state: "unstructured",
        checks: [],
        reason: expect.any(String)
      })
    }
  })

  it("rejects count and byte overflow without truncating requirements", () => {
    expect(
      parseSkillDependencies(
        native(
          Array.from({ length: 33 }, (_, i) => ({
            id: `bin-${i}`,
            kind: "executable",
            name: `bin${i}`
          }))
        )
      )
    ).toMatchObject({ state: "invalid", checks: [] })
    expect(
      parseSkillDependencies(
        openclaw({
          requires: { bins: Array.from({ length: 33 }, (_, i) => `bin${i}`) }
        })
      )
    ).toMatchObject({ state: "invalid", checks: [] })
    const bigChecks = Array.from({ length: 32 }, (_, i) => ({
      id: `file-${i}`,
      kind: "file",
      path: `${"a".repeat(480)}-${i}`,
      type: "file"
    }))
    expect(parseSkillDependencies(native(bigChecks))).toMatchObject({
      state: "invalid",
      checks: []
    })
    expect(
      skillDependencyDeclaration.safeParse({
        source: "cmbdevclaw",
        state: "structured",
        checks: bigChecks
      }).success
    ).toBe(false)
    expect(SKILL_DEPENDENCY_MAX_BYTES).toBe(8192)
  })

  it.each([
    "../outside",
    "/outside",
    "C:/outside",
    "a\\b",
    "a/../b",
    "a/./b",
    "a//b",
    "a/CON.txt",
    "a/com1",
    "a/file.",
    "a/file ",
    "a/file:stream",
    "a\u0000b"
  ])("rejects nonportable project file path %s", (path) => {
    expect(
      skillDependencyCheck.safeParse({
        id: "file",
        kind: "file",
        path,
        type: "file"
      }).success
    ).toBe(false)
  })

  it.each([
    "../node",
    "node;id",
    "node --version",
    "node\n",
    "C:\\node",
    "-flag",
    "$(id)",
    "node|id"
  ])("rejects unsafe executable name %s", (name) => {
    expect(skillDependencyCheck.safeParse({ id: "exe", kind: "executable", name }).success).toBe(
      false
    )
  })

  it.each(["v22.0.0", "22", "22.0", "022.0.0", "22.0.0-beta", "1000000000.0.0"])(
    "requires canonical three-part minimum version %s",
    (minimumVersion) => {
      expect(
        skillDependencyCheck.safeParse({
          id: "exe",
          kind: "executable",
          name: "node",
          minimumVersion
        }).success
      ).toBe(false)
    }
  )

  it("rejects unsupported mutable or executable fields in the shared wire schema", () => {
    expect(
      skillDependencyCheck.safeParse({
        id: "env",
        kind: "environment",
        name: "SERVICE_TOKEN",
        value: "do not disclose"
      }).success
    ).toBe(false)
    expect(
      skillDependencyDeclaration.safeParse({
        source: "cmbdevclaw",
        state: "structured",
        checks: []
      }).success
    ).toBe(false)
    expect(
      skillDependencyDeclaration.safeParse({
        source: "none",
        state: "absent",
        checks: [{ id: "git", kind: "executable", name: "git" }],
        reason: "absent"
      }).success
    ).toBe(false)
    expect(
      skillDependencyDeclaration.safeParse({
        source: "none",
        state: "absent",
        checks: []
      }).success
    ).toBe(false)
  })
})
