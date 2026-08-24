const GIT_REDIRECTION_ENV_NAMES = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_SHALLOW_FILE"
])

/** Whether a variable can redirect Git's repository identity, metadata, or
 * configuration before a command's subcommand is evaluated. Keep this shared
 * with the worktree command guard so spawned Git and direct `NAME=value git`
 * forms cannot drift apart. */
export function isGitRepositoryOverrideEnvironmentVariable(name: string): boolean {
  const upper = name.toUpperCase()
  return (
    GIT_REDIRECTION_ENV_NAMES.has(upper) ||
    /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upper)
  )
}

/** Git's environment overrides `git -C`, so app lifecycle commands and isolated
 * shells must never inherit repository/config redirection from the process that
 * launched Electron. Preserve ordinary environment variables while stripping
 * both the fixed names and the indexed `GIT_CONFIG_KEY_n/VALUE_n` family. */
export function withoutGitRepositoryOverrides(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>
): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue
    if (isGitRepositoryOverrideEnvironmentVariable(name)) {
      continue
    }
    clean[name] = value
  }
  return clean
}
