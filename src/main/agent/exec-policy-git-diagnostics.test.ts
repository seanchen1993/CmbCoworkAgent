import { describe, expect, it } from "vitest"
import { assessCommandSafety, type CommandShellSyntax } from "./exec-policy"

const CWD = "C:/repo"

// These are classifier inputs only. No shell or interpreter runs these commands.
describe("Git safety diagnostics", () => {
  const ordinaryScripts: Array<{
    name: string
    command: string
    shellSyntax: CommandShellSyntax
  }> = [
    {
      name: "JavaScript heredoc with a Set.add call",
      command: "node <<'EOF'\nconst seenKeys = new Set()\nseenKeys.add('input')\nEOF",
      shellSyntax: "posix"
    },
    {
      name: "Python heredoc with a set.add call",
      command: "python3 <<'PY'\nseen_keys = set()\nseen_keys.add('input')\nPY",
      shellSyntax: "posix"
    },
    {
      name: "heredoc with a variable named add",
      command: "node <<'EOF'\nconst add = (a, b) => a + b\nconsole.log(add(1, 2))\nEOF",
      shellSyntax: "posix"
    },
    {
      name: "ordinary rewrite command with JavaScript method calls",
      command:
        "node <<'EOF'\nconst fs = require('node:fs')\n" +
        "const seenKeys = new Set()\nseenKeys.add('input')\n" +
        "fs.writeFileSync('output.js', [...seenKeys].join('\\n'))\nEOF",
      shellSyntax: "posix"
    },
    {
      name: "quoted JavaScript inline code",
      command: "node -e \"const seenKeys = new Set(); seenKeys.add('input')\"",
      shellSyntax: "posix"
    },
    {
      name: "PowerShell here-string carrying ordinary JavaScript",
      command: "@'\nconst seenKeys = new Set()\nseenKeys.add('input')\n'@ | node",
      shellSyntax: "powershell"
    }
  ]

  it.each(ordinaryScripts)("reviews $name without inventing a Git operation", (input) => {
    const result = assessCommandSafety(input.command, CWD, { shellSyntax: input.shellSyntax })

    expect(result.level).toBe("needs_approval")
    expect(result.reason).not.toContain("forced git add")
  })

  it.each(["printf ok", "git add -f .env"])(
    "fails closed honestly at the shell nesting limit: %s",
    (innerCommand) => {
      let command = innerCommand
      for (let depth = 0; depth < 6; depth += 1) {
        command = `sh -c ${JSON.stringify(command)}`
      }

      const result = assessCommandSafety(command, CWD, { shellSyntax: "posix" })

      expect(result.level).toBe("forbidden")
      expect(result.reason).toContain("cannot verify Git operations safely")
    }
  )

  it.each([
    { command: "git add -f .env", shellSyntax: "posix" as const },
    { command: "git stage --force .env", shellSyntax: "posix" as const },
    { command: "bash -lc 'git add -f .env'", shellSyntax: "posix" as const },
    { command: 'powershell -Command "git add -f .env"', shellSyntax: "powershell" as const },
    { command: 'cmd /c "git add -f .env"', shellSyntax: "cmd" as const }
  ])("keeps the specific diagnosis for $command", ({ command, shellSyntax }) => {
    const result = assessCommandSafety(command, CWD, { shellSyntax })

    expect(result.level).toBe("forbidden")
    expect(result.reason).toContain("forced git add")
  })

  it.each([
    { command: "git add @args", shellSyntax: "powershell" as const },
    { command: "git add -$F .env", shellSyntax: "posix" as const },
    { command: "git add !F! .env", shellSyntax: "cmd" as const },
    { command: "${GIT:-git} add -f .env", shellSyntax: "posix" as const },
    { command: '& ("g"+"it") add -f .env', shellSyntax: "powershell" as const },
    { command: "$BIN add = -f .env", shellSyntax: "posix" as const },
    { command: "$BIN add.foo -f .env", shellSyntax: "posix" as const },
    { command: "$BIN foo.add -f .env", shellSyntax: "posix" as const },
    { command: "$BIN .add -f .env", shellSyntax: "posix" as const },
    { command: "$BIN seenKeys.add -f .env", shellSyntax: "posix" as const },
    { command: "$BIN const add -f .env", shellSyntax: "posix" as const },
    { command: "$BIN var commit", shellSyntax: "posix" as const },
    { command: "echo $($BIN add = -f .env)", shellSyntax: "posix" as const },
    { command: "$BIN commit :", shellSyntax: "posix" as const },
    { command: "%BIN% add = -f .env", shellSyntax: "cmd" as const },
    { command: "%BIN% commit.foo", shellSyntax: "cmd" as const },
    { command: "%BIN% const add -f .env", shellSyntax: "cmd" as const },
    { command: "Write-Output $(& $exe add = -f .env)", shellSyntax: "powershell" as const },
    {
      command: "Write-Output $(& $exe const add -f .env)",
      shellSyntax: "powershell" as const
    },
    { command: "& $exe foo.add -f .env", shellSyntax: "powershell" as const },
    { command: "$out = & $exe commit =", shellSyntax: "powershell" as const },
    { command: "/cmd/g?t.exe add = -f .env", shellSyntax: "posix" as const },
    { command: "/cmd/g?t.exe foo.add -f .env", shellSyntax: "posix" as const },
    { command: "sudo /cmd/g?t.exe foo.add -f .env", shellSyntax: "posix" as const },
    { command: "( /cmd/g?t.exe foo.add -f .env )", shellSyntax: "posix" as const },
    {
      command: 'function add() { "$BIN" "$@"; }; add add -f .env',
      shellSyntax: "posix" as const
    },
    {
      command: 'add() { "$BIN" "$@"; }; add add -f .env',
      shellSyntax: "posix" as const
    },
    {
      command: 'add( ) { "$BIN" "$@"; }; add add -f .env',
      shellSyntax: "posix" as const
    },
    {
      command: 'add() ( "$BIN" "$@" ); add add -f .env',
      shellSyntax: "posix" as const
    },
    {
      command: "function add { & $exe @args }; add add -f .env",
      shellSyntax: "powershell" as const
    },
    { command: "echo $($BIN add -f .env)", shellSyntax: "posix" as const },
    { command: "printf x >($BIN add -f .env)", shellSyntax: "posix" as const },
    { command: "x=$($BIN commit -m x -- a.ts)", shellSyntax: "posix" as const },
    { command: "sudo $BIN add -f .env", shellSyntax: "posix" as const },
    { command: "command $BIN add -f .env", shellSyntax: "posix" as const },
    { command: "env $BIN add -f .env", shellSyntax: "posix" as const },
    { command: "Write-Output $(& $exe add -f .env)", shellSyntax: "powershell" as const },
    { command: "Write-Output $(& $exe add('-f') .env)", shellSyntax: "powershell" as const },
    { command: "if ($true) { & $exe add('-f') .env }", shellSyntax: "powershell" as const },
    { command: "$out = & $exe add -f .env", shellSyntax: "powershell" as const },
    { command: "& $exe add ('-f') .env", shellSyntax: "powershell" as const },
    {
      command: "& $exe commit (Get-Content message.txt -Raw)",
      shellSyntax: "powershell" as const
    },
    {
      command: "& $exe commit(Get-Content message.txt -Raw)",
      shellSyntax: "powershell" as const
    },
    { command: "$BIN commit", shellSyntax: "posix" as const },
    { command: "$BIN write-tree", shellSyntax: "posix" as const },
    { command: "& $exe commit", shellSyntax: "powershell" as const },
    { command: "%BIN% commit", shellSyntax: "cmd" as const },
    {
      command: `powershell -EncodedCommand ${Buffer.from("git add -f .env", "utf16le").toString("base64")}`,
      shellSyntax: "powershell" as const
    }
  ])("rejects unverifiable Git syntax honestly: $command", ({ command, shellSyntax }) => {
    const result = assessCommandSafety(command, CWD, { shellSyntax })

    expect(result.level).toBe("forbidden")
    expect(result.reason).toContain("cannot verify Git operations safely")
  })

  it("still blocks a real force-add following a heredoc terminator", () => {
    const command =
      "node <<'EOF'\nconst seenKeys = new Set()\nseenKeys.add('input')\nEOF\n" + "git add -f .env"

    expect(assessCommandSafety(command, CWD, { shellSyntax: "posix" }).level).toBe("forbidden")
  })
})
