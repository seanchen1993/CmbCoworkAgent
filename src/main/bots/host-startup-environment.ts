import { botShellEnvironment } from "./shell-contract"
import { withInstalledBotNativeConfiguration } from "./native-shell-installed"

/** Privileged desktop → Host startup only. Command/Hook workers deliberately
 * keep using botShellEnvironment so private provider paths and policy inputs
 * never become model-command environment authority. Runtime probes still
 * verify every native package and OS isolation claim before admission. */
export function botHostStartupEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const startup = withInstalledBotNativeConfiguration(source)
  const environment = botShellEnvironment(startup)
  for (const key of [
    "CMB_BOT_NATIVE_SANDBOX_DIRECTORY",
    "CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256",
    "CMB_BOT_DELEGATED_CGROUP_DIRECTORY",
    "CMB_BOT_SHELL_PIDS_MAX",
    "CMB_BOT_SHELL_MEMORY_MAX_BYTES"
  ]) {
    if (startup[key] !== undefined) environment[key] = startup[key]!
  }
  return environment
}
