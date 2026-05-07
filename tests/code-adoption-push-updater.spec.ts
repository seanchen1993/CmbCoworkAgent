/**
 * Unit tests for marking code_adopt events as pushed.
 *
 * Run:
 *   npx tsx tests/code-adoption-push-updater.spec.ts
 */

import { buildCodeAdoptionPushedUpdateBody } from "../src/main/services/code-adoption-push-updater.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function getNested(value: unknown, path: Array<string | number>): unknown {
  let current = value as Record<string, unknown> | unknown[]
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function testUpdateBodyIncludesOriginRepositoryFields(): void {
  const body = buildCodeAdoptionPushedUpdateBody({
    commitShas: [" abc123 ", "abc123", "def456"],
    repoPath: "/tmp/local-folder-name",
    branch: "feature/test",
    remoteUrl: "git@git.example.internal:team/project.git",
    repositoryName: "project",
    repositoryFullName: "team/project",
    repositoryHost: "git.example.internal",
    repositoryWebUrl: "https://git.example.internal/team/project",
    commitUrlTemplate: "https://git.example.internal/team/project/commit/{sha}",
    pushedAt: "2026-04-30T12:00:00+08:00",
    pushOperationId: "push-1"
  })

  const scriptSource = getNested(body, ["script", "source"])
  const scriptParams = getNested(body, ["script", "params"]) as Record<string, unknown>
  const eventTerms = getNested(body, ["query", "bool", "filter", 0, "terms", "eventName"])
  const commitTerms = getNested(body, ["query", "bool", "filter", 1, "terms", "properties.commitSha"])

  assert(
    JSON.stringify(eventTerms) === JSON.stringify(["code_adopt", "git.commit.created"]),
    "update should mark both code_adopt and git.commit.created events"
  )
  assert(Array.isArray(commitTerms), "commitSha terms should be an array")
  assert(JSON.stringify(commitTerms) === JSON.stringify(["abc123", "def456"]), "commit shas should be trimmed and deduped")
  assert(scriptParams.repositoryName === "project", "repositoryName should come from parsed origin URL")
  assert(scriptParams.repositoryFullName === "team/project", "repositoryFullName should come from parsed origin URL")
  assert(scriptParams.repositoryHost === "git.example.internal", "repositoryHost should come from parsed origin URL")
  assert(
    typeof scriptSource === "string" && scriptSource.includes("ctx._source.properties.repositoryName = params.repositoryName;"),
    "code_adopt update should write repositoryName"
  )
  assert(
    typeof scriptSource === "string" && scriptSource.includes("ctx._source.properties.remoteUrl = params.remoteUrl;"),
    "code_adopt update should write canonical remoteUrl"
  )
  assert(
    typeof scriptSource === "string" && scriptSource.includes("ctx._source.properties.commitUrl = commitUrl;"),
    "code_adopt update should write commitUrl"
  )
  assert(
    typeof scriptSource === "string" && !scriptSource.includes("pushRepositoryName"),
    "code_adopt update should not duplicate repository fields under pushRepositoryName"
  )
  assert(
    typeof scriptSource === "string" && !scriptSource.includes("pushCommitUrl"),
    "code_adopt update should not duplicate commitUrl under pushCommitUrl"
  )
}

function run(): void {
  testUpdateBodyIncludesOriginRepositoryFields()
  console.log("PASS pushed telemetry update repository fields")
}

run()
