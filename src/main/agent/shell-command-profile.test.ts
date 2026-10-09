import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  profileShellCommand,
  extractShellCommandReadPaths,
  shellPathMatches
} from "./shell-command-profile"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

describe("shell command telemetry profiles", () => {
  it.each([
    "make test | tee report.html",
    "make test | sed 's/a/b/' | tee report.html",
    "bash -c 'make test' > report.html",
    "make test | bash -c 'sed s/passed/ok/' > report.html",
    "make test | bash -c 'bash -c \"sed s/passed/ok/\"' > report.html",
    "make test | { true; sed s/passed/ok/; } > report.html"
  ])("keeps excluded test stdout excluded through sinks: %s", async (command) => {
    const p = await profileShellCommand(command, "/ws")
    expect(p.canWrite).toBe(false)
    expect(p.effects).toContainEqual({ kind: "excluded", paths: ["/ws/report.html"] })
  })

  it("does not taint producers that ignore pipeline stdin", async () => {
    for (const command of [
      "make test | printf model > a.ts",
      "make test | bash -c 'printf model' > a.ts",
      "make test | bash -c 'cat template.ts' > a.ts"
    ]) {
      const p = await profileShellCommand(command, "/ws")
      expect(p.effects).toContainEqual({
        kind: command.includes("cat template") ? "transfer" : "model",
        paths: ["/ws/a.ts"]
      })
    }
  })

  it("propagates stdin provenance through a package script consumer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shell-profile-stdin-package-"))
    roots.push(root)
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { change: "sed s/passed/ok/" } })
    )
    const p = await profileShellCommand("make test | npm run change > report.html", root)
    expect(p.canWrite).toBe(false)
    expect(p.effects).toContainEqual({ kind: "excluded", paths: [path.join(root, "report.html")] })
  })

  it("distinguishes unknown output locations from workspace-wide writes", async () => {
    const p = await profileShellCommand('printf model > a.ts; make test > "$REPORT_PATH"', "/ws")
    expect(p.effects).toEqual([
      { kind: "model", paths: ["/ws/a.ts"] },
      { kind: "excluded", paths: [], scope: "unknown" }
    ])
  })

  it.each([
    'target=a.ts; (target=b.ts); printf model > "$target"; make test',
    'target=a.ts; if true; then (target=b.ts); fi; printf model > "$target"; make test',
    'target=a.ts; target=b.ts true; printf model > "$target"; make test'
  ])("keeps variable assignments within their Shell environment: %s", async (command) => {
    const p = await profileShellCommand(command, "/ws")
    expect(p.namedPaths).toEqual(["/ws/a.ts"])
  })

  it("keeps possible conditional assignments instead of trusting the last lexical branch", async () => {
    const p = await profileShellCommand(
      'target=a.ts; if false; then target=b.ts; else target=c.ts; fi; printf model > "$target"; make test',
      "/ws"
    )
    expect(p.namedPaths).toEqual(["/ws/a.ts", "/ws/b.ts", "/ws/c.ts"])
  })

  it.each(["false && target=b.ts", "true || target=b.ts", "false && { target=b.ts; }"])(
    "keeps both outcomes of conditional Shell lists: %s",
    async (statement) => {
      const p = await profileShellCommand(
        `target=a.ts; ${statement}; printf model > "$target"; make test`,
        "/ws"
      )
      expect(p.namedPaths).toContain("/ws/a.ts")
      expect(p.namedPaths).toContain("/ws/b.ts")
    }
  )

  it.each(["target=b.ts | cat", "{ target=b.ts; } | cat", "printf input | { target=b.ts; }"])(
    "does not leak pipeline sub-Shell assignments: %s",
    async (statement) => {
      const p = await profileShellCommand(
        `target=a.ts; ${statement}; printf model > "$target"; make test`,
        "/ws"
      )
      expect(p.namedPaths).toEqual(["/ws/a.ts"])
    }
  )

  it.each([
    'target=a.ts; if false; then target=b.ts; else printf model > "$target"; fi; make test',
    'target=a.ts; if false; then target=b.ts; elif true; then printf model > "$target"; fi; make test',
    "if false; then cd nested; else printf model > a.ts; fi; make test"
  ])(
    "restores the full environment when entering a mutually exclusive arm: %s",
    async (command) => {
      const p = await profileShellCommand(command, "/ws")
      expect(p.namedPaths).toEqual(["/ws/a.ts"])
    }
  )

  it.each(["false && cd nested", "true || cd nested"])(
    "keeps possible conditional cwd values: %s",
    async (prefix) => {
      const p = await profileShellCommand(`${prefix}; printf model > a.ts; make test`, "/ws")
      expect(p.namedPaths).toEqual(["/ws/a.ts", "/ws/nested/a.ts"])
      const edit = await profileShellCommand(`${prefix}; sed -i s/one/two/ a.ts; make test`, "/ws")
      expect(edit.namedPaths).toEqual(["/ws/a.ts", "/ws/nested/a.ts"])
    }
  )

  it("keeps cwd changes within a pipeline child environment", async () => {
    expect(
      (await profileShellCommand("cd nested | cat; printf model > a.ts; make test", "/ws"))
        .namedPaths
    ).toEqual(["/ws/a.ts"])
    const p = await profileShellCommand(
      "printf input | { cd nested; printf model > a.ts; }; printf model > b.ts",
      "/ws"
    )
    expect(p.namedPaths).toEqual(["/ws/nested/a.ts", "/ws/b.ts"])
  })

  it("attributes formatter stdout even when it is redirected without --write", async () => {
    const p = await profileShellCommand(
      "prettier template.ts > pretty.ts && printf model > a.ts",
      "/ws"
    )
    expect(p.effects).toEqual([
      { kind: "generated", paths: ["/ws/pretty.ts"] },
      { kind: "model", paths: ["/ws/a.ts"] }
    ])
  })

  it.each([
    "bash -c 'cat template.ts; printf generated' > combined.ts",
    "bash -c 'printf generated; cat template.ts' > combined.ts",
    "{ cat template.ts; printf generated; } > combined.ts"
  ])("does not erase copied stdout earlier/later in a composite producer: %s", async (command) => {
    const p = await profileShellCommand(command, "/ws")
    expect(p.effects).toContainEqual({ kind: "transfer", paths: ["/ws/combined.ts"] })
  })

  it("uses the effective package for each cwd and forwards script args", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shell-profile-nested-package-"))
    roots.push(root)
    await mkdir(path.join(root, "nested"))
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { tidy: "tsc --noEmit" } })
    )
    await writeFile(
      path.join(root, "nested", "package.json"),
      JSON.stringify({
        scripts: {
          tidy: `node -e "require('fs').writeFileSync('local.ts','code')"`,
          change: "tee"
        }
      })
    )
    for (const command of [
      "cd nested && npm run tidy",
      "npm --prefix nested run tidy",
      "pnpm -C nested run tidy"
    ]) {
      const p = await profileShellCommand(command, root)
      expect(p.canWrite).toBe(true)
      expect(p.hasLongRunning).toBe(false)
      expect(p.namedPaths).toContain(path.join(root, "nested", "local.ts"))
    }
    const forwarded = await profileShellCommand("cd nested && npm run change -- result.ts", root)
    expect(forwarded.namedPaths).toContain(path.join(root, "nested", "result.ts"))
    const pipeline = await profileShellCommand("npm test | tee report.html", root)
    expect(pipeline.canWrite).toBe(false)
  })
  it.each([
    'for i in $(seq 1 100); do echo "$i"; done > a.ts',
    "if true; then printf x; fi > a.ts",
    "{ printf x; } > a.ts",
    "(printf x) > a.ts",
    'target=a.ts; printf x > "$target"',
    "printf x > a.ts 2>&1",
    "printf x &> a.ts",
    "printf x &>> a.ts",
    "bash -c 'printf x' > a.ts",
    'echo "<<EOF"\nprintf x > a.ts'
  ])("preserves foreground writes through shell structure: %s", async (command) => {
    const p = await profileShellCommand(command, "/ws")
    expect(p.canWrite).toBe(true)
    expect(p.background).toBe(false)
    expect(p.effects).toContainEqual({ kind: "model", paths: ["/ws/a.ts"] })
  })

  it("keeps unresolved write targets observable instead of classifying them as read-only", async () => {
    const p = await profileShellCommand('printf x > "$UNKNOWN/file.ts"', "/ws")
    expect(p.canWrite).toBe(true)
    expect(p.unknownPaths).toBe(true)
    expect(p.effects).toEqual([{ kind: "model", paths: [], scope: "unknown" }])
  })

  it("does not treat download stdout or null-device redirections as unscoped file writes", async () => {
    for (const command of ["printf x > /dev/null", "curl https://example.invalid/t"]) {
      expect((await profileShellCommand(command, "/ws")).canWrite).toBe(false)
    }
    const p = await profileShellCommand("curl https://example.invalid/t && printf x > a.ts", "/ws")
    expect(p.effects).toEqual([{ kind: "model", paths: ["/ws/a.ts"] }])
    expect(
      (await profileShellCommand("curl -o a.ts https://example.invalid/t", "/ws")).effects
    ).toEqual([{ kind: "transfer", paths: ["/ws/a.ts"] }])
  })

  it.each([
    ["printf x | tee a.ts", "model"],
    ["cat template.ts | tee a.ts", "transfer"],
    ["cat template.ts | head -5 | tee a.ts", "transfer"],
    ["git show HEAD:template.ts | tee a.ts", "transfer"],
    ["curl https://example.invalid/t | tee a.ts", "transfer"],
    ["gofmt input.go | tee a.ts", "generated"],
    ["cat template.ts | sed 's/a/b/' | tee a.ts", "model"],
    ["bash -c 'cat template.ts' > a.ts", "transfer"]
  ])("preserves content provenance: %s", async (command, kind) => {
    const p = await profileShellCommand(command, "/ws")
    expect(p.effects.find((effect) => effect.paths.includes("/ws/a.ts"))?.kind).toBe(kind)
  })

  it("extracts interpreter heredoc paths without interpreting source as shell", async () => {
    const p = await profileShellCommand(
      "python3 <<'PY'\nopen('a.ts', 'w').write('code')\n# npm install\nPY\nmake test",
      "/ws"
    )
    expect(p.canWrite).toBe(true)
    expect(p.hasLongRunning).toBe(true)
    expect(p.namedPaths).toContain("/ws/a.ts")
    expect(p.effects.every((e) => e.kind === "model")).toBe(true)
  })

  it("converts MSYS drive paths only in a POSIX shell", async () => {
    const posix = await profileShellCommand("sed -i s/a/b/ /c/repo/a.ts", "C:/repo", "posix")
    expect(posix.namedPaths).toContain("c:\\repo\\a.ts")
    expect(shellPathMatches(posix.namedPaths[0], "C:/repo/a.ts")).toBe(true)
    const powershell = await profileShellCommand(
      "Set-Content /c/repo/a.ts x",
      "C:/repo",
      "powershell"
    )
    expect(powershell.namedPaths).not.toContain("c:\\repo\\a.ts")
    expect(extractShellCommandReadPaths("cat /c/repo/SKILL.md", "C:/repo", "posix")).toEqual([
      "c:\\repo\\SKILL.md"
    ])
  })

  it("preserves project script semantics and package-root cwd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shell-profile-policy-"))
    roots.push(root)
    await mkdir(path.join(root, "src"))
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          format: "node scripts/format.cjs",
          test: "node scripts/test.cjs",
          build: "node scripts/build.cjs",
          change: `node -e "require('fs').writeFileSync('a.ts','code')"`
        }
      })
    )
    expect(
      (await profileShellCommand("npm run format", root)).effects.every(
        (e) => e.kind === "generated"
      )
    ).toBe(true)
    for (const name of ["test", "build"]) {
      const p = await profileShellCommand(`npm run ${name}`, root)
      expect(p.canWrite).toBe(false)
      expect(p.hasLongRunning).toBe(true)
    }
    expect(
      (await profileShellCommand("npm run change", path.join(root, "src"))).namedPaths
    ).toContain(path.join(root, "a.ts"))
  })
  it.each([
    "printf 'x' > a.ts",
    "echo x >> a.ts",
    "sed -i 's/one/two/' a.ts",
    "perl -pi -e 's/a/b/g' a.ts",
    `node -e "require('fs').writeFileSync('a.ts','x')"`,
    `python -c "open('a.ts','w').write('x')"`,
    "sed 's/a/b/' old.ts > a.ts",
    "awk '{print $1}' old.ts > a.ts"
  ])("recognizes model-produced edits: %s", async (command) => {
    const p = await profileShellCommand(command, "/ws")
    expect(p.canWrite).toBe(true)
    expect(p.effects.some((e) => e.kind === "model")).toBe(true)
    expect(p.namedPaths).toContain("/ws/a.ts")
  })

  it.each([
    "prettier --write .",
    "eslint --fix src",
    "black .",
    "npm run format",
    "make fmt",
    "npm test -- -u"
  ])("attributes generators without counting: %s", async (command) => {
    const p = await profileShellCommand(command, "/ws")
    expect(p.canWrite).toBe(true)
    expect(p.effects.every((e) => e.kind === "generated")).toBe(true)
  })

  it.each([
    "cp template.ts a.ts",
    "mv tmp.ts a.ts",
    "git restore a.ts",
    "git checkout -- a.ts",
    "git show HEAD:a.ts > a.ts",
    "cat template.ts > a.ts",
    "curl https://example.com/a.ts > a.ts"
  ])("attributes transfers without counting: %s", async (command) => {
    const p = await profileShellCommand(command, "/ws")
    expect(p.canWrite).toBe(true)
    expect(p.effects.every((e) => e.kind === "transfer")).toBe(true)
  })

  it.each([
    "cat a.ts",
    "git status --short",
    "npm test > test.log",
    "npm run build > build.log",
    "npm install",
    "tsc --noEmit",
    "echo x",
    "printf x",
    "echo x > a.ts &"
  ])("does not capture read/build/background commands: %s", async (command) => {
    expect((await profileShellCommand(command, "/ws")).canWrite).toBe(false)
  })

  it("strips heredoc source instead of treating it as shell commands", async () => {
    const command = "cat > a.ts <<'EOF'\ncat SKILL.md\nnpm install\nEOF\ncat real.md"
    const p = await profileShellCommand(command, "/ws")
    expect(p.effects).toEqual([{ kind: "model", paths: ["/ws/a.ts"] }])
    expect(p.readPaths).toEqual(["/ws/real.md"])
  })

  it("extracts read paths, not expressions, writes, comments or flags", () => {
    expect(
      extractShellCommandReadPaths(
        "cd skills && cat 'demo/SKILL.md' | head -1 # cat fake.md",
        "/ws"
      )
    ).toEqual(["/ws/skills/demo/SKILL.md"])
    expect(extractShellCommandReadPaths("rg -g '*.ts' 'hello/world' src", "/ws")).toEqual([
      "/ws/src"
    ])
    expect(extractShellCommandReadPaths("sed 's/a/b/' input.ts > output.ts", "/ws")).toEqual([
      "/ws/input.ts"
    ])
  })

  it("keeps Windows backslashes and quoted paths", async () => {
    const p = await profileShellCommand(
      'cd /d "C:\\repo space" && echo x > "src\\hello.ts"',
      "C:\\other"
    )
    expect(p.namedPaths).toContain("C:\\repo space\\src\\hello.ts")
    expect(
      extractShellCommandReadPaths('Get-Content "C:\\repo space\\SKILL.md"', "C:\\repo")
    ).toEqual(["C:\\repo space\\SKILL.md"])
    expect(shellPathMatches("C:\\Repo\\src", "c:\\repo\\src\\x.ts")).toBe(true)
  })

  it("handles inline shell wrappers and for-loop scopes", async () => {
    expect((await profileShellCommand(`bash -c 'printf x > a.ts'`, "/ws")).namedPaths).toContain(
      "/ws/a.ts"
    )
    const p = await profileShellCommand('for f in src/*.ts; do sed -i "s/a/b/" "$f"; done', "/ws")
    expect(p.namedPaths).toContain("/ws/src/*.ts")
    expect(shellPathMatches("/ws/src/*.ts", "/ws/src/x.ts")).toBe(true)
    expect(shellPathMatches("/ws/src/*.ts", "/ws/src/deep/x.ts")).toBe(false)
  })

  it("reads package scripts asynchronously and invalidates the cache", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shell-profile-"))
    roots.push(root)
    await mkdir(path.join(root, "src"))
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          tidy: "prettier --write src",
          check: "tsc --noEmit",
          update: "node -e \"require('fs').writeFileSync('a.ts','x')\""
        }
      })
    )
    expect((await profileShellCommand("npm run tidy", root)).effects[0].kind).toBe("generated")
    expect((await profileShellCommand("npm run check", root)).canWrite).toBe(false)
    expect((await profileShellCommand("npm run update", root)).effects[0].kind).toBe("model")
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { tidy: "node -e \"require('fs').writeFileSync('different.ts','x')\"" }
      })
    )
    expect((await profileShellCommand("npm run tidy", root)).effects[0].kind).toBe("model")
  })

  it("counts scripts created in the same command, but not project formatter wrappers", async () => {
    const p = await profileShellCommand("printf x > fix.sh && bash fix.sh", "/ws")
    expect(p.effects.every((e) => e.kind === "model")).toBe(true)
    expect((await profileShellCommand("./scripts/format.sh", "/ws")).effects[0].kind).toBe(
      "generated"
    )
    expect((await profileShellCommand("bash /tmp/fix.sh", "/ws")).effects[0].kind).toBe("model")
    expect((await profileShellCommand("./scripts/change-files.sh", "/ws")).effects[0].kind).toBe(
      "model"
    )
    expect((await profileShellCommand("./scripts/test.sh", "/ws")).canWrite).toBe(false)
  })

  it.each(["printf x > temp.ts && mv temp.ts a.ts", "printf x > temp.ts && cp temp.ts a.ts"])(
    "keeps model-authored temporary content counted: %s",
    async (command) => {
      const p = await profileShellCommand(command, "/ws")
      expect(p.effects.every((e) => e.kind === "model")).toBe(true)
      expect(p.namedPaths).toContain("/ws/a.ts")
    }
  )

  it.each([
    "printf x > a.ts & sleep 1",
    "bash -c 'printf x > a.ts &'",
    "cat > a.ts <<'EOF'\nhello & world\nEOF"
  ])("distinguishes shell background operators from heredoc text: %s", async (command) => {
    expect((await profileShellCommand(command, "/ws")).canWrite).toBe(command.startsWith("cat"))
  })
})
