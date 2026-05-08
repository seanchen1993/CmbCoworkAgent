/**
 * Unit tests for Git remote URL parsing.
 *
 * Run:
 *   npx tsx tests/git-remote.spec.ts
 */

import { buildGitCommitUrl, parseGitRemoteInfo } from "../src/main/utils/git-remote.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function testHttpsRemote(): void {
  const info = parseGitRemoteInfo("https://gitee.internal/group/project.git")
  assert(info?.repositoryHost === "gitee.internal", "https host should be parsed")
  assert(info?.repositoryFullName === "group/project", "https repository full name should be parsed")
  assert(info?.repositoryName === "project", "https repository name should be parsed")
  assert(info?.repositoryWebUrl === "https://gitee.internal/group/project", "https web URL should strip .git")
  assert(
    buildGitCommitUrl(info, "abc123") === "https://gitee.internal/group/project/commit/abc123",
    "https commit URL should be built"
  )
}

function testSshScpRemote(): void {
  const info = parseGitRemoteInfo("git@gitee.internal:team/sub/project.git")
  assert(info?.repositoryHost === "gitee.internal", "ssh scp host should be parsed")
  assert(info?.repositoryFullName === "team/sub/project", "ssh scp full name should be parsed")
  assert(info?.repositoryName === "project", "ssh scp repository name should be parsed")
  assert(info?.repositoryWebUrl === "https://gitee.internal/team/sub/project", "ssh scp web URL should be inferred")
}

function testSshUrlRemoteWithPort(): void {
  const info = parseGitRemoteInfo("ssh://git@gitee.internal:2222/team/project.git")
  assert(info?.repositoryHost === "gitee.internal", "ssh URL web host should ignore SSH port")
  assert(info?.repositoryFullName === "team/project", "ssh URL full name should be parsed")
  assert(info?.repositoryWebUrl === "https://gitee.internal/team/project", "ssh URL web URL should be inferred")
}

function testConfiguredGiteeCommitUrl(): void {
  process.env.VITE_GIT_COMMIT_URL_MATCH_HOST = "git.example.internal,git-paas.example.internal,git-paas-alias.example.internal"
  process.env.VITE_GIT_REPOSITORY_URL_TEMPLATE = "http://git.example.internal/company/_source/{repositoryFullName}"
  process.env.VITE_GIT_COMMIT_URL_TEMPLATE = "http://git.example.internal/company/_source/{repositoryFullName}/-/commit/{sha}"

  const info = parseGitRemoteInfo("https://git-paas.example.internal/S992391/LF39.05_BCWplus_cust.git")
  assert(info?.repositoryName === "LF39.05_BCWplus_cust", "configured Gitee repository name should be parsed")
  assert(info?.repositoryFullName === "S992391/LF39.05_BCWplus_cust", "configured Gitee full path should be parsed")
  assert(
    info?.repositoryWebUrl ===
      "http://git.example.internal/company/_source/S992391/LF39.05_BCWplus_cust",
    "configured repository web URL should use the env template"
  )
  assert(
    buildGitCommitUrl(info, "118b1f336231137d67503b4a5abf251e75b6ce4c") ===
      "http://git.example.internal/company/_source/S992391/LF39.05_BCWplus_cust/-/commit/118b1f336231137d67503b4a5abf251e75b6ce4c",
    "configured commit URL should use the env template"
  )

  const aliasInfo = parseGitRemoteInfo("https://git-paas-alias.example.internal/S992391/LF39.05_BCWplus_cust.git")
  assert(
    buildGitCommitUrl(aliasInfo, "118b1f336231137d67503b4a5abf251e75b6ce4c") ===
      "http://git.example.internal/company/_source/S992391/LF39.05_BCWplus_cust/-/commit/118b1f336231137d67503b4a5abf251e75b6ce4c",
    "configured commit URL should support multiple matched remote hosts"
  )

  delete process.env.VITE_GIT_COMMIT_URL_MATCH_HOST
  delete process.env.VITE_GIT_REPOSITORY_URL_TEMPLATE
  delete process.env.VITE_GIT_COMMIT_URL_TEMPLATE
}

function run(): void {
  testHttpsRemote()
  console.log("PASS https remote parsing")
  testSshScpRemote()
  console.log("PASS ssh scp-like remote parsing")
  testSshUrlRemoteWithPort()
  console.log("PASS ssh URL remote parsing")
  testConfiguredGiteeCommitUrl()
  console.log("PASS configured Gitee commit URL")
}

run()
