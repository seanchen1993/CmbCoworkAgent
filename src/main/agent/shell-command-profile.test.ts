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
