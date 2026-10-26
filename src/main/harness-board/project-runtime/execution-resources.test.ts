import { mkdtempSync, mkdirSync, rmSync, writeFileSync, linkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { readRetainedExecutionResources } from "./execution-resources"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import {
  wrapProjectRuntimeManifest,
  EXECUTION_RESOURCES_PROTOCOL
} from "../../../shared/project-runtime"
import { parseRetainedAgentProfile } from "../../agent/agent-registry"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "execution-resources-"))
  roots.push(root)
  mkdirSync(join(root, "agents"))
  const repository = join(root, "repository")
  mkdirSync(repository)
  const profile = join(root, "agents/critic.md")
  writeFileSync(
    profile,
    "---\nname: domain-critic\nworkload: read_only\n---\nInspect without modifying files.\n"
  )
  writeFileSync(
    join(root, "devclaw.project-runtime.json"),
    JSON.stringify(
      wrapProjectRuntimeManifest(hostProjectFixture(root).manifest, {
        apiVersion: "devclaw.extension-contract/v1",
        requires: [EXECUTION_RESOURCES_PROTOCOL],
        executionResources: {
          profiles: ["agents/critic.md"],
          workspaces: [{ id: "backend", binding: "backendDirectory" }]
        }
      })
    )
  )
  return { root, repository, profile }
}

it("resolves declared workspace aliases and original profile permissions from retained sources", () => {
  const f = fixture()
  const bindings: string[] = []
  const read = () =>
    readRetainedExecutionResources(f.root, (binding) => {
      bindings.push(binding)
      return f.repository
    })!
  const resources = read()
  expect(bindings).toEqual(["backendDirectory"])
  expect(resources.profiles[0]).toMatchObject({
    name: "domain-critic",
    shellAccess: "read_only",
    disallowedTools: expect.arrayContaining(["write_file", "edit_file"])
  })
  expect(resources.workspaces).toEqual([{ id: "backend", path: expect.any(String) }])
  const first = resources.fingerprint
  expect(read().fingerprint).toBe(first)
  writeFileSync(f.profile, "---\nname: domain-critic\nworkload: verify\n---\nRun tests only.\n")
  expect(read().fingerprint).not.toBe(first)
  expect(read().profiles[0]).toMatchObject({
    shellAccess: "full",
    disallowedTools: expect.arrayContaining(["write_file", "edit_file"])
  })
  expect(() =>
    readRetainedExecutionResources(f.root, () => {
      throw Error("unconfigured")
    })
  ).toThrow("unconfigured")
})

it("rejects aliases and misspelled retained restrictions instead of silently granting extra tools", () => {
  const f = fixture()
  linkSync(f.profile, join(f.root, "aliased.md"))
  expect(() => readRetainedExecutionResources(f.root, () => f.repository)).toThrow()
  for (const policy of [
    "workload: readonly",
    "tools: Read,TypoTool",
    "shellAccess: none",
    "name: Explore",
    "workload: read_only\nWorkload: full"
  ])
    expect(() => parseRetainedAgentProfile("critic.md", `---\n${policy}\n---\nInspect.`)).toThrow()
})
