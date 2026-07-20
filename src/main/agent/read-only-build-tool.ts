/**
 * Shared read-only refinement for build/package/codegen tools.
 *
 * assessCommandSafety's "safe" tier (and the Windows safe-command parser) means
 * "auto-approve" (no user prompt) — NOT "no side effects". Both deliberately
 * auto-approve build/package/codegen tools (npm install, cargo build, make, go
 * run, javac …) because for a normal write-capable agent those are routine. A
 * READ-ONLY agent/worker must NOT run them: they write
 * node_modules/target/build artifacts/lockfiles or execute arbitrary project
 * code (test suites, run scripts, go run, java). This module decides whether a
 * build-tool invocation is PURE INSPECTION so the read-only gate can keep the
 * tools' read subcommands (npm ls, go list, cargo tree, mvn dependency:tree,
 * gradle dependencies …) while blocking the writers.
 *
 * It is shared by BOTH read-only gates so they agree:
 *   - exec-policy.ts        → POSIX / cross-platform path (isReadOnlyShellCommand)
 *   - windows-safe-commands → the `powershell -Command "<x>"` inner command
 *
 * When a subcommand's read/write nature is ambiguous it is treated as
 * write-capable (blocked): the agent can fall back to read_file on
 * package.json/go.mod/pom.xml, which is cheaper than letting a writer through.
 */

import path from "node:path"

export const BUILD_TOOL_EXECUTABLES = new Set([
  "mvn",
  "mvnw",
  "gradle",
  "gradlew",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "cargo",
  "go",
  "dotnet",
  "make",
  "cmake",
  "java",
  "javac"
])

// node package managers: inspection subcommands (everything else — install/add/
// update/remove/run/exec/test/ci/rebuild/dedupe/prune/link/pack/publish, and a
// BARE invocation, which for yarn/pnpm/bun means install — is write-capable).
const READ_ONLY_NODE_PM_SUBCOMMANDS = new Set([
  "ls",
  "list",
  "ll",
  "la",
  "outdated",
  "why",
  "view",
  "v",
  "info",
  "show",
  "search",
  "s",
  "audit",
  "licenses",
  "fund",
  "ping",
  "root",
  "prefix",
  "bin",
  "doctor",
  "home",
  "repo",
  "docs",
  "help",
  "whoami"
])
const READ_ONLY_CARGO_SUBCOMMANDS = new Set([
  "tree",
  "metadata",
  "search",
  "version",
  "locate-project",
  "verify-project",
  "read-manifest",
  "pkgid"
])
// go: read-only subcommands. build/run/install/get/generate/test/clean/fmt/fix/
// tool/work all write or execute; `mod` and `env` are split by their args below.
const READ_ONLY_GO_SUBCOMMANDS = new Set(["list", "version", "doc", "vet"])
const READ_ONLY_GO_MOD_SUBCOMMANDS = new Set(["graph", "why", "verify"])
const READ_ONLY_GRADLE_TASKS = new Set([
  "dependencies",
  "dependencyinsight",
  "tasks",
  "projects",
  "properties",
  "help",
  "components",
  "model",
  "buildenvironment",
  "javatoolchains",
  "outgoingvariants",
  "dependentcomponents"
])
const READ_ONLY_MVN_GOAL_PREFIXES = [
  "dependency:tree",
  "dependency:list",
  "dependency:analyze",
  "dependency:resolve",
  "dependency:display-ancestors",
  "help:",
  "versions:display-"
]
// version/help/info flags are read-only for ANY build tool.
const BUILD_TOOL_VERSION_HELP_FLAGS = new Set([
  "-v",
  "--version",
  "-version",
  "-h",
  "--help",
  "--info",
  "--list-sdks",
  "--list-runtimes"
])

/** Normalize a raw executable token to a bare lowercase name (drop directory and
 * the Windows .exe/.cmd/.bat/.com extension) so `C:\\tools\\npm.cmd` → `npm`. */
export function normalizeBuildToolExecutable(raw: string): string {
  return path
    .basename(raw)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com)$/i, "")
}

/** True when every arg after the executable is a version/help/info flag. */
function isVersionOrHelpInvocation(tokens: string[]): boolean {
  const rest = tokens.slice(1)
  return rest.length > 0 && rest.every((t) => BUILD_TOOL_VERSION_HELP_FLAGS.has(t.toLowerCase()))
}

/**
 * SAFE_EXECUTABLES / SAFE_POWERSHELL_COMMANDS members whose READ form is
 * diagnostic but which carry a WRITE / system-change subcommand or flag the plain
 * name-allowlist would wave through. Keyed by the bare lowercased command; the
 * regex matches the offending token. Shared by the POSIX gate (exec-policy) and
 * the Windows/PowerShell gates (windows-safe-commands) so both agree. `-o` is
 * per-command (output-file for sort/tree/base64, read-only for ls/grep).
 */
export const SAFE_COMMAND_WRITE_FLAGS: Record<string, RegExp> = {
  sort: /^(-o|--output)/, // sort -o FILE / --output=FILE → writes a file
  tree: /^(-o|--output)/, // tree -o FILE → writes a file
  base64: /^(-o|--output)/, // base64 -o FILE → writes a file
  date: /^(-s|--set)/, // date -s … / --set=… → sets the system clock
  diff: /^--output/, // diff/sdiff --output=FILE → writes a file
  // network tools: read forms (arp -a, route print, netsh … show, ipconfig /all)
  // stay safe; their mutate verbs/flags below do not.
  arp: /^-[ds]$/, // arp -d (delete entry) / -s (set static entry)
  route: /^(add|del|delete|change|flush|-f)$/, // route add/del/change/flush
  netsh: /^(add|delete|set|reset|import|export|exec|-f|\/f)$/, // netsh … set/add/delete/reset/import/export/exec + -f//f (runs a script file) (read: show/dump)
  ipconfig: /^\/(release|release6|renew|renew6|flushdns|registerdns|setclassid)/ // ipconfig /release|/renew|/flushdns|… mutate
}

/** True iff `command` (bare lowercased name; .exe/.cmd/… tolerated) carries a
 * write/system-change flag from SAFE_COMMAND_WRITE_FLAGS. */
export function hasUnsafeWriteFlag(command: string, tokens: string[]): boolean {
  const bare = command.replace(/\.(exe|cmd|bat|com)$/i, "")
  const re = SAFE_COMMAND_WRITE_FLAGS[bare]
  return re !== undefined && tokens.slice(1).some((t) => re.test(t.toLowerCase()))
}

/** True iff there is ≥1 non-flag arg and ALL non-flag args satisfy `pred` (used
 * for goal/task tools where a bare invocation runs the default build). */
function allNonFlagArgsMatch(tokens: string[], pred: (arg: string) => boolean): boolean {
  let sawArg = false
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].startsWith("-")) continue
    sawArg = true
    if (!pred(tokens[i])) return false
  }
  return sawArg
}

/** True iff a build/package/codegen invocation is pure inspection (no writes, no
 * code execution). `executable` must already be normalized (see
 * normalizeBuildToolExecutable) and be in BUILD_TOOL_EXECUTABLES. */
export function isReadOnlyBuildToolInvocation(executable: string, tokens: string[]): boolean {
  if (isVersionOrHelpInvocation(tokens)) return true
  const sub = tokens[1]?.toLowerCase()
  switch (executable) {
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      if (!sub || !READ_ONLY_NODE_PM_SUBCOMMANDS.has(sub)) return false
      // `audit` reports (read-only) but a `fix` writes the lockfile/tree. Block
      // BOTH the subcommand form (`npm audit fix`) and the flag form
      // (`npm audit --fix`, `--fix=...`, possibly after other flags like
      // `--force`), across npm/pnpm/yarn.
      if (
        sub === "audit" &&
        tokens.slice(2).some((t) => {
          const l = t.toLowerCase()
          return l === "fix" || /^--?fix(=|$)/.test(l)
        })
      ) {
        return false
      }
      return true
    case "cargo":
      return !!sub && READ_ONLY_CARGO_SUBCOMMANDS.has(sub)
    case "go":
      // -vettool / -toolexec / -exec run an ARBITRARY program during the go
      // invocation (`go vet -vettool=/x`, `go list -toolexec=/x ./...`), and
      // -overlay redirects source files. None is read-only — and the go branch
      // returns on the subcommand alone (no allNonFlagArgsMatch), so reject these
      // explicitly across every go subcommand, in both `=value` and space forms.
      // Go's flag package treats `-flag` and `--flag` as EQUIVALENT, so match an
      // optional second dash (`--?`) too.
      if (
        tokens
          .slice(1)
          .some((t) => /^--?(vettool|toolexec|exec|overlay)(=|$)/.test(t.toLowerCase()))
      ) {
        return false
      }
      // `go mod graph|why|verify` read; `go mod tidy|download|init|edit` write.
      if (sub === "mod") return READ_ONLY_GO_MOD_SUBCOMMANDS.has(tokens[2]?.toLowerCase() ?? "")
      // `go env` prints; `go env -w|-u` mutates persistent env config. Match all
      // flag spellings Go accepts: -w / -u / --w / --u and the `=value` forms
      // (-w=true, …). Read-only flags like -json / -changed stay allowed.
      if (sub === "env") return !tokens.slice(2).some((t) => /^--?[wu](=|$)/.test(t.toLowerCase()))
      return !!sub && READ_ONLY_GO_SUBCOMMANDS.has(sub)
    case "gradle":
    case "gradlew":
      // allNonFlagArgsMatch only vets the non-flag TASKS, ignoring flags — but
      // several flags make even a read task (dependencies/tasks) write or EXECUTE
      // arbitrary code:
      //  - --write-* (--write-locks, --write-verification-metadata) writes files;
      //  - -I/--init-script runs an init script (arbitrary Groovy/Kotlin);
      //  - -b/--build-file, -c/--settings-file, -p/--project-dir point gradle at a
      //    DIFFERENT build/settings script (= code at the configuration phase);
      //  - -g/--gradle-user-home, --include-build load code from elsewhere;
      //  - --profile writes an HTML report, --scan publishes a build scan
      //    (network/external), --refresh-dependencies re-downloads (network + cache
      //    write). (`--no-scan` disables it → NOT matched by `--scan`.)
      // (The configuration phase running the project's OWN build.gradle for
      // dependencies/tasks is a knowingly-accepted tradeoff — only the flags above
      // that ADD writes/network/codepaths are rejected here.)
      // NOTE: -I (init-script) is CASE-SENSITIVE — lowercase -i is --info (read-only),
      // so the `-bcpg` / `-I` checks must not carry the /i flag.
      if (
        tokens.some(
          (t) =>
            /^--(write-|init-script|build-file|settings-file|project-dir|gradle-user-home|include-build|profile|scan|refresh-dependencies)/i.test(
              t
            ) ||
            /^-I/.test(t) ||
            /^-[bcpg]/.test(t)
        )
      ) {
        return false
      }
      return allNonFlagArgsMatch(tokens, (a) => READ_ONLY_GRADLE_TASKS.has(a.toLowerCase()))
    case "mvn":
    case "mvnw":
      // Same blind spot for flags allNonFlagArgsMatch ignores:
      //  - -DoutputFile=… / -Dmdep.outputFile=… WRITE a file;
      //  - -Dmaven.ext.class.path=… loads an extension JAR = ARBITRARY CODE;
      //  - -f/--file (alternate POM) / -s/--settings/-gs/--global-settings (which
      //    can point at attacker-controlled plugin repos) redirect the build.
      if (
        tokens.some((t) => {
          const l = t.toLowerCase()
          return (
            /outputfile/.test(l) || // -DoutputFile= / -Dmdep.outputFile= (dependency plugin)
            /^-doutput=/.test(l) || // -Doutput=<file> (help:effective-pom/-settings WRITE it; -DoutputType to stdout is NOT matched)
            /maven\.ext\./.test(l) || // -Dmaven.ext.class.path=… extension JAR = code
            /^-s/.test(l) || // -s / -s<file> (settings is the only mvn -s flag)
            /^(--settings|-gs|--global-settings)(=|$)/.test(l) ||
            // -f / -f= / -f<path> / -f<relative> (alternate POM = external build
            // definition). -f is ambiguous: -fae/-ff/-fn are fail-mode flags, so
            // reject every -f… EXCEPT those three (negative lookahead).
            /^-f(?!ae$|f$|n$)/.test(l) ||
            /^--file(=|$)/.test(l)
          )
        })
      ) {
        return false
      }
      return allNonFlagArgsMatch(tokens, (a) => {
        const l = a.toLowerCase()
        return READ_ONLY_MVN_GOAL_PREFIXES.some((p) => l === p || l.startsWith(p))
      })
    // make has NO provably-read-only invocation beyond --version/--help (handled
    // by isVersionOrHelpInvocation above): even `make -n`/`-p`/`-q` PARSE the
    // project Makefile, which evaluates `$(shell …)` functions at parse time —
    // i.e. arbitrary command execution. So make falls through to `false` here.
    case "dotnet":
      // `dotnet list package|reference` reads; build/run/test/publish/restore write.
      return sub === "list"
    // make / cmake / java / javac build or execute by default — only the
    // version/help forms handled above are read-only.
    default:
      return false
  }
}
