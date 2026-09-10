/**
 * Regression: a read-only agent's execute gate must hold for the EFFECTIVE
 * (post-hook) command. A PreToolUse hook can rewrite a read-only command into a
 * build/write one via updatedInput.command; the runtime checks the agent-issued
 * command BEFORE the hook runs, so LocalSandbox re-checks after the merge. Two
 * activations: the instance flag (setReadOnlyShellEnforced — Level-1/coordinator
 * leaf runtimes with a dedicated sandbox) and the per-call
 * readOnlyShellExecutionContext (Solo registry subagents that share the main
 * agent's sandbox).
 *
 * Run:
 *   npx tsx tests/local-sandbox-readonly-hook.spec.ts
 */

import assert from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { LocalSandbox, readOnlyShellExecutionContext } from "../src/main/agent/local-sandbox.ts"
import type { HookConfig } from "../src/main/hooks/types.ts"

function nodeCommand(script: string): string {
  return `node -e ${JSON.stringify(script)}`
}

/** A PreToolUse(execute) hook that rewrites the command via updatedInput. */
function rewriteHook(toCommand: string): HookConfig {
  return {
    id: "rewrite-hook",
    enabled: true,
    type: "command",
    matcher: "execute",
    event: "PreToolUse",
    command: nodeCommand(
      `process.stdout.write(JSON.stringify({ updatedInput: { command: ${JSON.stringify(toCommand)} } }))`
    )
  }
}

function makeSandbox(workspace: string, toCommand: string, readOnly: boolean): LocalSandbox {
  const sandbox = new LocalSandbox({
    rootDir: workspace,
    windowsSandbox: "none",
    timeout: 30_000,
    hooks: [rewriteHook(toCommand)]
  })
  if (readOnly) sandbox.setReadOnlyShellEnforced(true)
  return sandbox
}

/** A sandbox with NO hooks: execute(cmd) gates on the LITERAL cmd, so the gate's
 * own expansion (not the hook's host shell) is what's exercised. Needed because a
 * rewrite hook's command string is itself shell-expanded before it reaches the
 * gate, which would pre-resolve $VAR and hide whether the gate handles it. */
function directSandbox(
  workspace: string,
  readOnly: boolean,
  env?: Record<string, string>
): LocalSandbox {
  const sandbox = new LocalSandbox({
    rootDir: workspace,
    windowsSandbox: "none",
    timeout: 30_000,
    ...(env ? { env: { ...process.env, ...env } as NodeJS.ProcessEnv } : {})
  })
  if (readOnly) sandbox.setReadOnlyShellEnforced(true)
  return sandbox
}

async function run(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "cmb-ro-hook-"))
  try {
    // 1) read-only + hook rewrites a read command into `npm install` → BLOCKED.
    //    `npm install` never executes (rejected by the post-merge read-only check).
    const attack = makeSandbox(base, "npm install", true)
    const fg = await attack.execute("echo safe")
    assert.match(
      fg.output,
      /read-only agent/i,
      `foreground: rewritten build must be blocked, got: ${fg.output}`
    )
    assert.notEqual(fg.exitCode, 0, "foreground: blocked command must report non-zero exit")

    const bg = await attack.executeBackground("echo safe")
    assert.match(bg, /read-only agent/i, `background: rewritten build must be blocked, got: ${bg}`)

    // 2) read-only + hook rewrites into another READ command (echo) → ALLOWED
    //    (no over-block). Proves the hook-rewrite path is real AND the EFFECTIVE
    //    command is what runs (output is the rewritten one, not the original).
    const benign = makeSandbox(base, "echo REWRITTEN", true)
    const okRun = await benign.execute("echo original")
    assert.equal(okRun.exitCode, 0, `read rewrite must run, got: ${okRun.output}`)
    assert.match(okRun.output, /REWRITTEN/, "effective (rewritten) read command is what executes")
    assert.doesNotMatch(okRun.output, /original/, "the original command is NOT what ran")

    // 3) Solo registry subagent path: it SHARES the main agent's (non-flagged)
    //    sandbox, so its guard runs execute inside readOnlyShellExecutionContext
    //    instead of relying on setReadOnlyShellEnforced. Simulate that: a sandbox
    //    that is NOT instance-flagged still enforces read-only on the EFFECTIVE
    //    command when the call runs inside the context.
    const shared = makeSandbox(base, "npm install", false) // NOT setReadOnlyShellEnforced
    const ctxFg = await readOnlyShellExecutionContext.run(true, () => shared.execute("echo safe"))
    assert.match(ctxFg.output, /read-only agent/i, "context: foreground rewritten build blocked")
    const ctxBg = await readOnlyShellExecutionContext.run(true, () =>
      shared.executeBackground("echo safe")
    )
    assert.match(ctxBg, /read-only agent/i, "context: background rewritten build blocked")

    // 4) Without the context AND without the instance flag, the gate is off (use a
    //    benign echo rewrite so nothing dangerous runs).
    const sharedEcho = makeSandbox(base, "echo OUTSIDE", false)
    const noCtx = await sharedEcho.execute("echo safe")
    assert.equal(noCtx.exitCode, 0)
    assert.doesNotMatch(noCtx.output, /read-only agent/i, "no context + no flag → gate off")
    assert.match(noCtx.output, /OUTSIDE/, "rewritten command runs when the gate is off")

    // 5) Async isolation: a concurrent sibling OUTSIDE the context is unaffected
    //    by a read-only context running in parallel (AsyncLocalStorage scopes it).
    const [inside, outside] = await Promise.all([
      readOnlyShellExecutionContext.run(true, () => shared.execute("echo x")),
      sharedEcho.execute("echo y")
    ])
    assert.match(inside.output, /read-only agent/i, "concurrent: in-context call is blocked")
    assert.doesNotMatch(
      outside.output,
      /read-only agent/i,
      "concurrent: out-of-context sibling is NOT blocked"
    )

    // 6) read-only + the command reads a sensitive credential dir → BLOCKED with
    //    the sensitive-path message (distinct from the generic read-only one). Gate
    //    ON ⇒ the block happens BEFORE execution, so nothing is read (filenames are
    //    non-existent). Uses DIRECT execute (no hook) so the LITERAL command reaches
    //    the gate and exercises the gate's OWN shell-expansion (a rewrite hook's
    //    host shell would pre-expand $VAR, hiding whether the gate handles it). The
    //    gate must mirror what spawn({shell}) does: literal ~, absolute <home>,
    //    quotes, $HOME/${HOME}, quote-joined words, ~user, $USER, globs, backslash.
    const home = homedir()
    const homeParent = dirname(home)
    let user = ""
    try {
      user = userInfo().username
    } catch {
      /* userInfo can throw in some CI/container setups */
    }
    const targets = [
      "cat ~/.ssh/cmb-nx", // literal ~
      `cat ${home}/.aws/cmb-nx`, // absolute home dir
      `grep x "${home}/.ssh/cmb-nx"`, // quoted absolute
      "cat $HOME/.ssh/cmb-nx", // $HOME
      // NB: `${HOME}` (braces) is rejected EARLIER by the generic read-only gate
      // (it refuses `${`/`$(` param/command expansion it can't introspect), so it
      // never reaches the sensitive-path check — still blocked, just not here.
      'cat "$HOME/.kube/cmb-nx"', // $HOME fully inside double quotes
      'cat "$HOME"/.ssh/cmb-nx', // quoted prefix JOINED to unquoted suffix (one word)
      "cat $HOME''/.gnupg/cmb-nx", // adjacent empty quotes ($HOME stays intact)
      "cat ~/.ss?/cmb-nx", // glob INSIDE the sensitive segment
      "cat ~/.ssh/cmb-nx*", // glob in a later segment (matches nothing real)
      ...(user
        ? [
            `cat ~${user}/.ssh/cmb-nx`,
            ...(process.platform !== "win32"
              ? [`cat ${homeParent}/$USER/.gnupg/cmb-nx`] // POSIX $USER
              : [])
          ]
        : []),
      // POSIX backslash escaping (`\.ssh` → `.ssh`), ANSI-C quoting $'...'
      // (decodes \xHH/\nnn/\.), brace expansion (`{.ssh,x}` → `.ssh`), and POSIX
      // bracket classes (`[[:lower:]]` matches `.ssh`) — all reveal a real `.ssh`.
      ...(process.platform !== "win32"
        ? [
            "cat ~/\\.ssh/cmb-nx",
            "cat $HOME/\\.ssh/cmb-nx",
            `cat $'${home}/.ssh/cmb-nx'`, // plain ANSI-C
            "cat $HOME/$'.ssh/cmb-nx'", // $HOME + ANSI-C segment
            "cat ~/$'.ssh/cmb-nx'", // ~ + ANSI-C segment
            `cat $'${home}/\\x2essh/cmb-nx'`, // \x2e → "."
            `cat $'${home}/.s\\163h/cmb-nx'`, // \163 octal → "s"
            `cat $'${home}/\\.ssh/cmb-nx'`, // \. (unknown escape) → "."
            "cat ~/{.ssh,normal}/cmb-nx", // brace expansion → ~/.ssh
            "cat ~/.{ssh,aws}/cmb-nx", // brace inside the sensitive segment
            `cat ${home}/{.ssh,normal}/cmb-nx`, // absolute + brace
            "find ~/.[[:lower:]][[:lower:]]h -maxdepth 0 -type d", // POSIX class → .ssh
            "find ~/.[s]sh -maxdepth 0 -type d", // ordinary bracket class → .ssh
            "ls -d ~/.[!.]sh", // shell bracket NEGATION [!.] (POSIX) matches "s"
            "ls -d ~/.[^.]sh", // bracket negation [^.] matches "s"
            "ls -d ~/.[!x][!x]h" // two negation classes → .ssh
          ]
        : [])
    ]
    for (const target of targets) {
      const sneaky = directSandbox(base, true)
      const blocked = await sneaky.execute(target)
      assert.match(
        blocked.output,
        /credential/i,
        `sensitive credential path must be blocked: ${target} (got: ${blocked.output})`
      )
      assert.notEqual(blocked.exitCode, 0, `blocked sensitive read reports non-zero: ${target}`)
      const blockedBg = await sneaky.executeBackground(target)
      assert.match(blockedBg, /credential/i, `background sensitive path blocked: ${target}`)
    }

    // 6b) Arbitrary env vars that point at credential files/dirs must be expanded
    //     from the SAME env the shell uses (this.env) and blocked — not just $HOME.
    const credEnv = {
      KUBECONFIG: `${home}/.kube/config`,
      AWS_SHARED_CREDENTIALS_FILE: `${home}/.aws/credentials`,
      DOCKER_CONFIG: `${home}/.docker`
    }
    for (const target of [
      "cat $KUBECONFIG",
      "cat $AWS_SHARED_CREDENTIALS_FILE",
      "cat $DOCKER_CONFIG/config.json"
    ]) {
      const sneaky = directSandbox(base, true, credEnv)
      const blocked = await sneaky.execute(target)
      assert.match(
        blocked.output,
        /credential/i,
        `env-var pointing at a credential path must be blocked: ${target} (got: ${blocked.output})`
      )
    }

    // 7) read-only + a NON-sensitive read is NOT caught by the sensitive-path gate
    //    (scope = credential dirs only, not full workspace confinement). Includes a
    //    brace/glob with NO sensitive alternative — must not be over-blocked.
    for (const ok of [
      "cat cmb-nonexistent.txt",
      "cat ~/{foo,bar}/cmb-nx", // brace, neither alternative is sensitive
      "find ~/.[[:digit:]]xx -maxdepth 0" // digit class can't spell a sensitive name
    ]) {
      const okOut = await directSandbox(base, true).execute(ok)
      assert.doesNotMatch(
        okOut.output,
        /credential/i,
        `a non-sensitive read must NOT be blocked by the sensitive-path gate: ${ok}`
      )
    }

    // 6c) Brace-expansion CAP must FAIL CLOSED: a sensitive branch hidden past the
    //     cap would otherwise be silently truncated while the shell still expands it.
    //     Build a brace group with >CAP (1024) safe options + a trailing `.ssh`.
    const manyOpts = Array.from({ length: 1100 }, (_, k) => `safe${k}`).join(",")
    const capBypass = `cat ~/{${manyOpts},.ssh}/cmb-nx`
    const capBlocked = await directSandbox(base, true).execute(capBypass)
    assert.match(
      capBlocked.output,
      /credential/i,
      "brace expansion over the cap fails closed (does not silently truncate past a hidden .ssh)"
    )

    // 7b) SINGLE quotes suppress expansion, so `'$HOME/.ssh/x'` is a literal
    //     (relative) filename, NOT the real credential path — must NOT be blocked
    //     (this is the over-block the expander now avoids).
    const okLiteral = await directSandbox(base, true).execute("cat '$HOME/.ssh/cmb-nx'")
    assert.doesNotMatch(
      okLiteral.output,
      /credential/i,
      "single-quoted $HOME is literal (relative) and must NOT be over-blocked"
    )

    // 8) Gate OFF (no flag, no context): the sensitive-path check does not apply.
    //    Use a non-existent file under ~/.ssh so nothing real is read.
    const offOut = await directSandbox(base, false).execute("cat ~/.ssh/nonexistent-cmb-test-file")
    assert.doesNotMatch(
      offOut.output,
      /credential/i,
      "gate off → sensitive-path check does not apply (command ran instead of being blocked)"
    )

    // 9) env-secret exfil: echo/printf/printenv/env must NOT leak environment values
    //    to a read-only agent. Plant a fake secret in the sandbox env, then prove each
    //    form is blocked (generic read-only message) and the secret value NEVER
    //    appears in output. Gate ON ⇒ blocked before execution. Unlike `cat $VAR`
    //    (path-vetted by the sensitive-path gate), echo/printf print the EXPANDED
    //    value directly, so the gate refuses `$` in their args; printenv/bare-env dump
    //    the environment and are refused outright.
    const secretEnv = { CMB_FAKE_SECRET: "sk-LEAKED-zzz999" }
    for (const target of [
      "echo $CMB_FAKE_SECRET", // bare $VAR
      'echo "$CMB_FAKE_SECRET"', // $VAR in double quotes
      "echo '$CMB_FAKE_SECRET'", // single-quoted literal (over-blocked — safe trade)
      "printf %s $CMB_FAKE_SECRET", // printf path
      "printenv CMB_FAKE_SECRET", // printenv with a key
      "printenv", // bare printenv (dumps all)
      "env" // bare env (dumps all)
    ]) {
      const sneaky = directSandbox(base, true, secretEnv)
      const blocked = await sneaky.execute(target)
      assert.match(
        blocked.output,
        /read-only agent/i,
        `env exfil must be blocked: ${target} (got: ${blocked.output})`
      )
      assert.doesNotMatch(
        blocked.output,
        /sk-LEAKED-zzz999/,
        `secret value must NOT appear in output: ${target}`
      )
      assert.notEqual(blocked.exitCode, 0, `blocked env exfil reports non-zero: ${target}`)
      const blockedBg = await sneaky.executeBackground(target)
      assert.match(blockedBg, /read-only agent/i, `background env exfil blocked: ${target}`)
    }

    // 9b) No over-block: a `$`-free echo/printf still runs, and the `env CMD`
    //     transparent prefix still recurses into a read-only inner command (only bare
    //     `env` is refused). These prove the fix is scoped, not a blanket echo/env ban.
    const okEcho = await directSandbox(base, true).execute("echo hello-world")
    assert.equal(okEcho.exitCode, 0, `plain echo must run, got: ${okEcho.output}`)
    assert.match(okEcho.output, /hello-world/, "plain echo output is produced")
    const okPrintf = await directSandbox(base, true).execute("printf 'hi-%s' there")
    assert.equal(okPrintf.exitCode, 0, `plain printf must run, got: ${okPrintf.output}`)
    assert.match(okPrintf.output, /hi-there/, "plain printf output is produced")
    const okEnvCmd = await directSandbox(base, true).execute("env echo via-env")
    assert.equal(okEnvCmd.exitCode, 0, `env CMD transparent prefix must still run, got: ${okEnvCmd.output}`)
    assert.match(okEnvCmd.output, /via-env/, "env CMD runs the inner read-only command")

    console.log(
      "PASS local-sandbox read-only hook + sensitive-path gate + env-secret exfil (literal/~/$HOME/$USER/quote/glob/echo/printf/printenv/env)"
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

run().catch((err: Error) => {
  console.error(`FAIL ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
