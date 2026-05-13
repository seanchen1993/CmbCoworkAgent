export interface GitRemoteInfo {
  remoteUrl: string
  repositoryHost: string
  repositoryFullName: string
  repositoryName: string
  repositoryWebUrl: string
  commitUrlTemplate: string
}

function readEnv(name: string): string {
  const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  return String(metaEnv?.[name] ?? process.env[name] ?? "").trim()
}

function getSpecialHosts(): Set<string> {
  return new Set(
    readEnv("VITE_GIT_COMMIT_URL_MATCH_HOST")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  )
}

function getSpecialRepositoryUrlTemplate(): string {
  return readEnv("VITE_GIT_REPOSITORY_URL_TEMPLATE")
}

function getSpecialCommitUrlTemplate(): string {
  return readEnv("VITE_GIT_COMMIT_URL_TEMPLATE")
}

function stripGitSuffix(value: string): string {
  return value
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
}

function fillGitUrlTemplate(template: string, args: { repositoryName: string; repositoryFullName: string; commitSha?: string }): string {
  return template
    .replace(/\{repo\}/g, encodeURIComponent(args.repositoryName))
    .replace(/\{repositoryName\}/g, encodeURIComponent(args.repositoryName))
    .replace(/\{repositoryFullName\}/g, args.repositoryFullName.split("/").map(encodeURIComponent).join("/"))
    .replace(/\{sha\}/g, encodeURIComponent(args.commitSha ?? ""))
    .replace(/\{commitSha\}/g, encodeURIComponent(args.commitSha ?? ""))
}

function buildInfo(remoteUrl: string, host: string, repoPath: string, webProtocol = "https:"): GitRemoteInfo | null {
  const repositoryFullName = stripGitSuffix(repoPath)
  if (!repositoryFullName) return null
  const parts = repositoryFullName.split("/").filter(Boolean)
  const repositoryName = parts[parts.length - 1] ?? repositoryFullName
  const repositoryHost = host.trim()
  const specialHosts = getSpecialHosts()
  const isSpecialHost = specialHosts.size > 0 && specialHosts.has(repositoryHost.toLowerCase())
  const specialRepositoryTemplate = isSpecialHost ? getSpecialRepositoryUrlTemplate() : ""
  const specialCommitTemplate = isSpecialHost ? getSpecialCommitUrlTemplate() : ""
  const genericRepositoryWebUrl = repositoryHost ? `${webProtocol}//${repositoryHost}/${repositoryFullName}` : ""
  const repositoryWebUrl = specialRepositoryTemplate
    ? fillGitUrlTemplate(specialRepositoryTemplate, { repositoryName, repositoryFullName })
    : genericRepositoryWebUrl
  const commitUrlTemplate = specialCommitTemplate || (repositoryWebUrl ? `${repositoryWebUrl}/commit/{sha}` : "")

  return {
    remoteUrl,
    repositoryHost,
    repositoryFullName,
    repositoryName,
    repositoryWebUrl,
    commitUrlTemplate
  }
}

export function parseGitRemoteInfo(remoteUrl: string): GitRemoteInfo | null {
  const trimmed = remoteUrl.trim()
  if (!trimmed) return null

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol === "file:") return null
      const webProtocol = parsed.protocol === "http:" ? "http:" : "https:"
      const webHost = parsed.protocol === "http:" || parsed.protocol === "https:"
        ? parsed.host
        : parsed.hostname
      return buildInfo(trimmed, webHost, decodeURIComponent(parsed.pathname), webProtocol)
    } catch {
      // fall through to scp-like parsing
    }
  }

  const scpLike = trimmed.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/)
  if (scpLike) {
    return buildInfo(trimmed, scpLike[1], scpLike[2], "https:")
  }

  return null
}

export function buildGitCommitUrl(remoteInfo: GitRemoteInfo | null, commitSha: string): string {
  const sha = commitSha.trim()
  if (!remoteInfo?.commitUrlTemplate || !sha) return ""
  return fillGitUrlTemplate(remoteInfo.commitUrlTemplate, {
    repositoryName: remoteInfo.repositoryName,
    repositoryFullName: remoteInfo.repositoryFullName,
    commitSha: sha
  })
}
