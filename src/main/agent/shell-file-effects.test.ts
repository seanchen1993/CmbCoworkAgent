import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
  mkdir,
  realpath
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"

// Control only observation scheduling, not Git/file contents or classifications.
const observationGate = vi.hoisted(() => ({
  afterLstat: undefined as ((file: string) => Promise<void>) | undefined,
  afterRealpath: undefined as ((file: string) => Promise<void>) | undefined
}))
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const info = await actual.lstat(...args)
      await observationGate.afterLstat?.(String(args[0]))
      return info
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const resolved = await actual.realpath(...args)
      await observationGate.afterRealpath?.(String(args[0]))
      return resolved
    }
  }
})
import {
  beginShellFileCapture,
  noteFileToolWrite,
  type ShellFileCapture
} from "./shell-file-effects"

const roots: string[] = []
const git = (root: string, ...args: string[]): void => {
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" })
}
async function repo(): Promise<string> {
  const raw = await mkdtemp(path.join(tmpdir(), "shell-effects-"))
  roots.push(raw)
  const root = await realpath(raw)
  git(root, "init", "-q")
  git(root, "config", "user.name", "Test")
  git(root, "config", "user.email", "test@example.invalid")
  await writeFile(path.join(root, "a.ts"), "const a = 1\n")
  await writeFile(path.join(root, "b.ts"), "const a = 1\n")
  git(root, "add", ".")
  git(root, "commit", "-qm", "seed")
  return root
}
async function capture(
  root: string,
  command = "sed -i 's/1/2/' a.ts",
  limits = {}
): Promise<ShellFileCapture> {
  const c = await beginShellFileCapture({
    workspaceRoot: root,
    command,
    cwd: root,
    isCodeFile: (p) => p.endsWith(".ts"),
    limits
  })
  expect(c).not.toBeNull()
  return c!
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

describe("shell file effects against real Git repositories", () => {
  it("hands clean restored content from a C window to an overlapping model edit", async () => {
    const root = await repo(),
      file = path.join(root, "a.ts")
    await writeFile(file, "preexisting dirty\n")
    const a = await capture(root),
      b = await capture(root, "git restore a.ts")
    git(root, "restore", "a.ts")
    expect((await b.finish()).changes.find((change) => change.absPath === file)?.decision).toBe(
      "attributed"
    )
    await writeFile(file, "new model\n")
    const change = (await a.finish()).changes.find((change) => change.absPath === file)
    expect(change?.decision).toBe("counted")
    expect(change?.before?.toString()).toBe("const a = 1\n")
    expect(change?.after?.toString()).toBe("new model\n")
  })

  it.each(["git restore a.ts", "cp b.ts a.ts"])(
    "retains the preimage of a model peer joining during a C observation: %s",
    async (command) => {
      const root = await repo(),
        file = path.join(root, "a.ts"),
        sentinel = path.join(root, "z.ts")
      await writeFile(file, "preexisting dirty\n")
      await writeFile(path.join(root, "b.ts"), "copied B\n")
      await writeFile(sentinel, "dirty sentinel\n")
      const b = await capture(root, command)
      execFileSync("bash", ["-c", command], { cwd: root, stdio: "pipe" })
      let reached!: () => void, resume!: () => void
      const paused = new Promise<void>((resolve) => {
        reached = resolve
      })
      const resumed = new Promise<void>((resolve) => {
        resume = resolve
      })
      observationGate.afterLstat = async (target) => {
        if (target !== sentinel) return
        observationGate.afterLstat = undefined
        reached()
        await resumed
      }
      const slowFinish = b.finish()
      let a: ShellFileCapture | undefined
      try {
        await paused
        a = await capture(root, "printf 'new model\\n' > a.ts")
        resume()
        expect((await slowFinish).changes.find((change) => change.absPath === file)?.decision).toBe(
          "attributed"
        )
        execFileSync("bash", ["-c", "printf 'new model\\n' > a.ts"], { cwd: root, stdio: "pipe" })
        const change = (await a.finish()).changes.find((change) => change.absPath === file)
        expect(change?.decision).toBe("counted")
        expect(change?.before?.toString()).toBe(
          command.startsWith("git") ? "const a = 1\n" : "copied B\n"
        )
        expect(change?.after?.toString()).toBe("new model\n")
      } finally {
        observationGate.afterLstat = undefined
        resume()
        await slowFinish
        await a?.finish()
      }
    }
  )

  it("does not publish an older file-tool fact after a newer write note", async () => {
    const root = await repo(),
      file = path.join(root, "a.ts"),
      c = await capture(root)
    await writeFile(file, "old file-tool write\n")
    let reached!: () => void, resume!: () => void
    const paused = new Promise<void>((resolve) => {
      reached = resolve
    })
    const resumed = new Promise<void>((resolve) => {
      resume = resolve
    })
    observationGate.afterRealpath = async (target) => {
      if (target !== file) return
      observationGate.afterRealpath = undefined
      reached()
      await resumed
    }
    const oldNote = noteFileToolWrite(file, "old file-tool write\n")
    try {
      await paused
      await writeFile(file, "new file-tool write\n")
      await noteFileToolWrite(file, "new file-tool write\n")
      resume()
      await oldNote
      await writeFile(file, "model write\n")
      const change = (await c.finish()).changes.find((change) => change.absPath === file)
      expect(change?.decision).toBe("counted")
      expect(change?.before?.toString()).toBe("new file-tool write\n")
    } finally {
      observationGate.afterRealpath = undefined
      resume()
      await oldNote
      await c.finish()
    }
  })

  it
    .skipIf(process.platform === "win32")
    .each([
      "make test | bash -c 'sed s/passed/ok/' > wrapper-report.html",
      "make test | npm run change > wrapper-report.html"
    ])("keeps test stdout excluded through a real recursive consumer: %s", async (pipeline) => {
    const root = await repo()
    await writeFile(path.join(root, "Makefile"), "test:\n\t@printf '<p>test passed</p>\\n'\n")
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { change: "sed s/passed/ok/" } })
    )
    const command = pipeline + "; printf 'new model\\n' > a.ts"
    const c = await beginShellFileCapture({
      workspaceRoot: root,
      cwd: root,
      command,
      isCodeFile: () => true
    })
    execFileSync("bash", ["-c", command], { cwd: root, stdio: "pipe" })
    const changes = (await c!.finish()).changes
    expect(
      changes.find((change) => change.absPath === path.join(root, "wrapper-report.html"))?.reason
    ).toBe("excluded-output")
    expect(
      changes.filter((change) => change.decision === "counted").map((change) => change.absPath)
    ).toEqual([path.join(root, "a.ts")])
  })

  it.skipIf(process.platform === "win32").each(["make test", "cat b.ts", "prettier b.ts"])(
    "does not let unknown output locations hide an explicit model write: %s",
    async (producer) => {
      const root = await repo()
      await writeFile(path.join(root, "Makefile"), "test:\n\t@printf 'test passed\\n'\n")
      const command = `printf 'new model\\n' > a.ts; ${producer} > "$REPORT_PATH"`
      const c = await capture(root, command)
      execFileSync("bash", ["-c", command], {
        cwd: root,
        stdio: "pipe",
        env: { ...process.env, REPORT_PATH: path.join(root, "report.log") }
      })
      const change = (await c.finish()).changes.find(
        (change) => change.absPath === path.join(root, "a.ts")
      )
      expect(change?.decision).toBe("counted")
      expect(change?.after?.toString()).toBe("new model\n")
    }
  )

  it
    .skipIf(process.platform === "win32")
    .each([
      'target=a.ts; (target=b.ts); printf "new model\\n" > "$target"; make test',
      'target=a.ts; if false; then target=b.ts; fi; printf "new model\\n" > "$target"; make test',
      'target=a.ts; target=b.ts true; printf "new model\\n" > "$target"; make test',
      'target=a.ts; false && target=b.ts; printf "new model\\n" > "$target"; make test',
      'target=a.ts; true || target=b.ts; printf "new model\\n" > "$target"; make test',
      'target=a.ts; target=b.ts | cat; printf "new model\\n" > "$target"; make test',
      'target=a.ts; { target=b.ts; } | cat; printf "new model\\n" > "$target"; make test',
      'target=a.ts; if false; then target=b.ts; else printf "new model\\n" > "$target"; fi; make test',
      'target=a.ts; if false; then target=b.ts; elif true; then printf "new model\\n" > "$target"; fi; make test',
      'false && cd nested; printf "new model\\n" > a.ts; make test',
      'true || cd nested; printf "new model\\n" > a.ts; make test',
      'cd nested | cat; printf "new model\\n" > a.ts; make test',
      'if false; then cd nested; else printf "new model\\n" > a.ts; fi; make test'
    ])("counts the file actually written using scoped variables: %s", async (command) => {
    const root = await repo()
    await mkdir(path.join(root, "nested"))
    await writeFile(path.join(root, "Makefile"), "test:\n\t@true\n")
    const c = await capture(root, command)
    execFileSync("bash", ["-c", command], { cwd: root, stdio: "pipe" })
    const changes = (await c.finish()).changes
    expect(
      changes.filter((change) => change.decision === "counted").map((change) => change.absPath)
    ).toEqual([path.join(root, "a.ts")])
    expect(
      changes.find((change) => change.absPath === path.join(root, "a.ts"))?.after?.toString()
    ).toBe("new model\n")
  })

  it.each(["prettier --write a.ts", "git restore a.ts"])(
    "rejects a stale B/C observation before it can overwrite a newer model note: %s",
    async (command) => {
      const root = await repo(),
        file = path.join(root, "a.ts"),
        pausedFile = path.join(root, "z.ts")
      await writeFile(pausedFile, "preexisting dirty\n")
      const a = await capture(root),
        b = await capture(root, command),
        c = await capture(root)
      await writeFile(file, "formatted or copied B\n")
      let reached!: () => void, resume!: () => void
      const paused = new Promise<void>((resolve) => {
        reached = resolve
      })
      const resumed = new Promise<void>((resolve) => {
        resume = resolve
      })
      observationGate.afterLstat = async (target) => {
        if (target !== pausedFile) return
        observationGate.afterLstat = undefined
        reached()
        await resumed
      }
      const slowFinish = b.finish()
      try {
        await paused
        await writeFile(file, "model A\n")
        expect((await a.finish()).changes.find((change) => change.absPath === file)?.decision).toBe(
          "counted"
        )
        resume()
        const stale = (await slowFinish).changes.find((change) => change.absPath === file)
        expect(stale?.reason).toBe("stale-observation")
        await writeFile(file, "model A\nmodel C\n")
        const final = (await c.finish()).changes.find((change) => change.absPath === file)
        expect(final?.decision).toBe("counted")
        expect(final?.before?.toString()).toBe("model A\n")
        expect(final?.after?.toString()).toBe("model A\nmodel C\n")
      } finally {
        observationGate.afterLstat = undefined
        resume()
        await slowFinish
        await a.finish()
        await c.finish()
      }
    }
  )

  it.skipIf(process.platform === "win32")(
    "excludes real test logs piped to a code extension, including mixed model writes",
    async () => {
      const root = await repo()
      await writeFile(path.join(root, "Makefile"), "test:\n\t@printf '<p>test passed</p>\\n'\n")
      const command = "make test | tee report.html; printf 'model edit\\n' > a.ts"
      const c = await beginShellFileCapture({
        workspaceRoot: root,
        cwd: root,
        command,
        isCodeFile: () => true
      })
      execFileSync("bash", ["-c", command], { cwd: root, stdio: "pipe" })
      const changes = (await c!.finish()).changes
      expect(
        changes.find((change) => change.absPath === path.join(root, "report.html"))?.reason
      ).toBe("excluded-output")
      expect(
        changes.filter((change) => change.decision === "counted").map((change) => change.absPath)
      ).toEqual([path.join(root, "a.ts")])
    }
  )

  it.skipIf(process.platform === "win32")(
    "does not count mixed transfer stdout from a real nested shell",
    async () => {
      const root = await repo()
      const command = "bash -c 'cat a.ts; printf generated' > combined.ts"
      const c = await capture(root, command)
      execFileSync("bash", ["-c", command], { cwd: root, stdio: "pipe" })
      expect((await c.finish()).changes[0].decision).toBe("attributed")
    }
  )

  it.skipIf(process.platform === "win32")(
    "attributes real formatter stdout without counting it as model code",
    async () => {
      const root = await repo()
      await writeFile(path.join(root, "template.ts"), "const value={hello:1};\n")
      const command = "prettier template.ts > pretty.ts; printf 'model edit\\n' > a.ts"
      const c = await capture(root, command)
      execFileSync("bash", ["-c", command], { cwd: root, stdio: "pipe" })
      const changes = (await c.finish()).changes
      expect(
        changes.find((change) => change.absPath === path.join(root, "pretty.ts"))?.decision
      ).toBe("attributed")
      expect(
        changes.filter((change) => change.decision === "counted").map((change) => change.absPath)
      ).toEqual([path.join(root, "a.ts")])
    }
  )

  it("runs the nested package's actual script instead of classifying the parent package", async () => {
    const root = await repo(),
      nested = path.join(root, "nested")
    await mkdir(nested)
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { tidy: "tsc --noEmit" } })
    )
    await writeFile(
      path.join(nested, "package.json"),
      JSON.stringify({ scripts: { tidy: "node edit.cjs" } })
    )
    await writeFile(
      path.join(nested, "edit.cjs"),
      "require('fs').writeFileSync('local.ts', 'nested code\\n')"
    )
    const c = await capture(root, "cd nested && npm run tidy")
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "tidy"], {
      cwd: nested,
      stdio: "pipe"
    })
    expect(
      (await c.finish()).changes
        .filter((change) => change.decision === "counted")
        .map((change) => change.absPath)
    ).toEqual([path.join(nested, "local.ts")])
  })
  it("hands the first-completed named observation to a later-completed older window", async () => {
    const root = await repo(),
      a = await capture(root),
      b = await capture(root)
    await writeFile(path.join(root, "a.ts"), "second window first\n")
    const first = (await b.finish()).changes[0]
    expect(first.decision).toBe("counted")
    expect(first.before?.toString()).toBe("const a = 1\n")
    await writeFile(path.join(root, "a.ts"), "first window second\n")
    const second = (await a.finish()).changes[0]
    expect(second.decision).toBe("counted")
    expect(second.before?.toString()).toBe("second window first\n")
  })

  it("counts rebuilding a predeleted tracked file even when it becomes clean", async () => {
    const root = await repo()
    await rm(path.join(root, "a.ts"))
    const c = await capture(root, "printf 'const a = 1' > a.ts")
    await writeFile(path.join(root, "a.ts"), "const a = 1\n")
    const change = (await c.finish()).changes[0]
    expect(change.decision).toBe("counted")
    expect(change.before?.toString()).toBe("")
    expect(change.after?.toString()).toBe("const a = 1\n")
  })

  it("keeps a confirmed deletion as an empty preimage for an overlapping rebuild", async () => {
    const root = await repo(),
      deletion = await capture(root, "rm a.ts"),
      rebuild = await capture(root)
    await rm(path.join(root, "a.ts"))
    expect((await deletion.finish()).changes[0].decision).toBe("counted")
    await writeFile(path.join(root, "a.ts"), "rebuilt\n")
    const change = (await rebuild.finish()).changes[0]
    expect(change.decision).toBe("counted")
    expect(change.before?.toString()).toBe("")
    expect(change.after?.toString()).toBe("rebuilt\n")
  })

  it("atomically admits at most 64 simultaneous captures and releases their slots", async () => {
    const root = await repo()
    const opened = await Promise.all(
      Array.from({ length: 66 }, () =>
        beginShellFileCapture({
          workspaceRoot: root,
          cwd: root,
          command: "sed -i s/1/2/ a.ts",
          isCodeFile: (p) => p.endsWith(".ts"),
          limits: { beforeMs: 20000, afterMs: 20000, gitMs: 10000, slowMs: 10000 }
        })
      )
    )
    expect(opened.filter(Boolean)).toHaveLength(64)
    await Promise.all(opened.map((c) => c?.finish()))
    const next = await capture(root)
    await next.finish()
    // Read-only and failed admission paths must also release their reservation.
    for (let i = 0; i < 66; i++)
      expect(
        await beginShellFileCapture({
          workspaceRoot: root,
          cwd: root,
          command: "cat a.ts",
          isCodeFile: () => true
        })
      ).toBeNull()
    await (await capture(root)).finish()
  }, 30000)

  it("does not count real package formatter/test/build script writes", async () => {
    const root = await repo()
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { format: "node format.cjs", test: "node format.cjs", build: "node format.cjs" }
      })
    )
    await writeFile(
      path.join(root, "format.cjs"),
      "require('fs').writeFileSync('a.ts', 'formatted\\n')"
    )
    const c = await capture(root, "npm run format")
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "format"], {
      cwd: root,
      stdio: "pipe"
    })
    expect((await c.finish()).changes[0].decision).toBe("attributed")
    for (const script of ["test", "build"])
      expect(
        await beginShellFileCapture({
          workspaceRoot: root,
          cwd: root,
          command: `npm run ${script}`,
          isCodeFile: () => true
        })
      ).toBeNull()
  })
  it("captures the clean HEAD preimage and changed content", async () => {
    const root = await repo(),
      c = await capture(root)
    await writeFile(path.join(root, "a.ts"), "const a = 2\n")
    const changes = (await c.finish()).changes
    expect(changes).toHaveLength(1)
    expect(changes[0].decision).toBe("counted")
    expect(changes[0].before?.toString()).toBe("const a = 1\n")
    expect(changes[0].after?.toString()).toBe("const a = 2\n")
    expect(await c.finish()).toEqual({ changes })
  })

  it("uses a dirty preimage, not HEAD, and ignores preexisting unchanged dirt", async () => {
    const root = await repo()
    await writeFile(path.join(root, "a.ts"), "human change\n")
    await writeFile(path.join(root, "b.ts"), "existing dirt\n")
    const c = await capture(root)
    await writeFile(path.join(root, "a.ts"), "agent change\n")
    const changes = (await c.finish()).changes
    expect(changes).toHaveLength(1)
    expect(changes[0].before?.toString()).toBe("human change\n")
  })

  it("handles identical HEAD blob hashes in the same cat-file batch", async () => {
    const root = await repo(),
      c = await capture(root, "unknown-editor")
    await writeFile(path.join(root, "a.ts"), "A\n")
    await writeFile(path.join(root, "b.ts"), "B\n")
    const changes = (await c.finish()).changes
    expect(changes.filter((x) => x.decision === "counted")).toHaveLength(2)
    expect(changes.every((x) => x.before?.toString() === "const a = 1\n")).toBe(true)
  })

  it("handles new and empty files, deletions and dirty-to-clean reverts", async () => {
    const root = await repo()
    await writeFile(path.join(root, "b.ts"), "dirty\n")
    const c = await capture(root, "unknown-editor")
    await writeFile(path.join(root, "new.ts"), "new\n")
    await writeFile(path.join(root, "empty.ts"), "")
    await rm(path.join(root, "a.ts"))
    git(root, "restore", "b.ts")
    const changes = (await c.finish()).changes
    expect(changes.find((x) => x.absPath.endsWith("new.ts"))?.before?.toString()).toBe("")
    expect(changes.find((x) => x.absPath.endsWith("a.ts"))?.after?.toString()).toBe("")
    expect(changes.find((x) => x.absPath.endsWith("b.ts"))?.after?.toString()).toBe("const a = 1\n")
    expect(changes.some((x) => x.absPath.endsWith("empty.ts"))).toBe(true)
  })

  it.each(["prettier --write .", "cp b.ts a.ts", "git restore a.ts"])(
    "attributes non-model writes without code-gen: %s",
    async (command) => {
      const root = await repo(),
        c = await capture(root, command)
      await writeFile(path.join(root, "a.ts"), "changed\n")
      expect((await c.finish()).changes.map((x) => x.decision)).toEqual(["attributed"])
    }
  )

  it("does not double-count a successful file-tool write", async () => {
    const root = await repo(),
      c = await capture(root)
    await writeFile(path.join(root, "a.ts"), "file tool\n")
    await noteFileToolWrite(path.join(root, "a.ts"), "file tool\n")
    expect((await c.finish()).changes).toEqual([])
  })

  it("does not evaluate lazy file-tool content outside an observation window", async () => {
    const root = await repo()
    let encoded = false
    await noteFileToolWrite(path.join(root, "a.ts"), () => {
      encoded = true
      return "never encoded"
    })
    expect(encoded).toBe(false)
  })

  it("counts only Shell changes made after an overlapping file-tool write", async () => {
    const root = await repo(),
      c = await capture(root)
    await writeFile(path.join(root, "a.ts"), "file tool\n")
    await noteFileToolWrite(path.join(root, "a.ts"), "file tool\n")
    await writeFile(path.join(root, "a.ts"), "shell afterward\n")
    expect((await c.finish()).changes[0].before?.toString()).toBe("file tool\n")
  })

  it("does not count ambiguous unnamed overlapping windows, even the last to finish", async () => {
    const root = await repo(),
      a = await capture(root, "editor-one"),
      b = await capture(root, "editor-two")
    await writeFile(path.join(root, "a.ts"), "ambiguous\n")
    expect((await a.finish()).changes[0].decision).toBe("unattributed")
    expect((await b.finish()).changes[0].decision).toBe("unattributed")
  })

  it("prefers the window naming the file", async () => {
    const root = await repo(),
      unknown = await capture(root, "editor-one"),
      explicit = await capture(root)
    await writeFile(path.join(root, "a.ts"), "named\n")
    expect((await unknown.finish()).changes[0].decision).toBe("unattributed")
    expect((await explicit.finish()).changes[0].decision).toBe("counted")
  })

  it("uses the completed named window as the next overlapping window's preimage", async () => {
    const root = await repo(),
      a = await capture(root),
      b = await capture(root)
    await writeFile(path.join(root, "a.ts"), "first\n")
    await a.finish()
    await writeFile(path.join(root, "a.ts"), "second\n")
    expect((await b.finish()).changes[0].before?.toString()).toBe("first\n")
  })

  it("long commands only attribute named paths", async () => {
    const root = await repo(),
      c = await capture(root, "sed -i 's/1/2/' a.ts", { shortMs: 0 })
    await writeFile(path.join(root, "a.ts"), "named\n")
    await writeFile(path.join(root, "b.ts"), "other\n")
    const changes = (await c.finish()).changes
    expect(changes.find((x) => x.absPath.endsWith("a.ts"))?.decision).toBe("counted")
    expect(changes.find((x) => x.absPath.endsWith("b.ts"))?.decision).toBe("unattributed")
  })

  it("formatter scopes override model edits in the same command", async () => {
    const root = await repo(),
      c = await capture(root, "sed -i 's/1/2/' a.ts && prettier --write .")
    await writeFile(path.join(root, "a.ts"), "formatted\n")
    expect((await c.finish()).changes[0].decision).toBe("attributed")
  })

  it("uses raw bytes, supports dirty cache invalidation and skips oversized content", async () => {
    const root = await repo()
    await writeFile(path.join(root, "a.ts"), Buffer.from([0xc4, 0xe3, 10]))
    const c = await capture(root)
    await writeFile(path.join(root, "a.ts"), Buffer.from([0xba, 0xc3, 10]))
    expect(Buffer.isBuffer((await c.finish()).changes[0].before)).toBe(true)
    const large = await capture(root, "editor", { fileBytes: 4 })
    await writeFile(path.join(root, "a.ts"), "too large\n")
    expect((await large.finish()).changes[0].decision).toBe("attributed")
  })

  it("does not follow symlinks, count directory entries or untracked nested repos", async () => {
    const root = await repo(),
      c = await capture(root, "editor")
    await symlink(path.join(root, "a.ts"), path.join(root, "linked.ts"))
    await mkdir(path.join(root, "nested"))
    git(path.join(root, "nested"), "init", "-q")
    await writeFile(path.join(root, "nested", "secret.ts"), "nested\n")
    await mkdir(path.join(root, "folder.ts"))
    expect((await c.finish()).changes).toEqual([])
  })

  it("handles rename as deletion plus creation", async () => {
    const root = await repo(),
      c = await capture(root, "mv a.ts renamed.ts")
    await rename(path.join(root, "a.ts"), path.join(root, "renamed.ts"))
    expect((await c.finish()).changes).toHaveLength(2)
  })

  it("skips entry-budget overflow without changing the command outcome", async () => {
    const root = await repo()
    await writeFile(path.join(root, "a.ts"), "dirty\n")
    await writeFile(path.join(root, "b.ts"), "dirty\n")
    expect(
      await beginShellFileCapture({
        workspaceRoot: root,
        cwd: root,
        command: "editor",
        isCodeFile: () => true,
        limits: { entries: 1 }
      })
    ).toBeNull()
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("dirty\n")
  })

  it("does not capture read-only commands or background execution", async () => {
    const root = await repo()
    for (const command of ["cat a.ts", "npm test", "echo x > a.ts &"])
      expect(
        await beginShellFileCapture({
          workspaceRoot: root,
          cwd: root,
          command,
          isCodeFile: () => true
        })
      ).toBeNull()
  })

  it("supports a workspace containing multiple repositories", async () => {
    const raw = await mkdtemp(path.join(tmpdir(), "shell-workspace-"))
    roots.push(raw)
    const workspace = await realpath(raw),
      first = await repo(),
      second = await repo()
    await rename(first, path.join(workspace, "first"))
    await rename(second, path.join(workspace, "second"))
    const c = await beginShellFileCapture({
      workspaceRoot: workspace,
      cwd: workspace,
      command: "editor",
      isCodeFile: (p) => p.endsWith(".ts")
    })
    expect(c).not.toBeNull()
    await writeFile(path.join(workspace, "first", "a.ts"), "first edit\n")
    await writeFile(path.join(workspace, "second", "a.ts"), "second edit\n")
    expect((await c!.finish()).changes.filter((x) => x.decision === "counted")).toHaveLength(2)
  })

  it("captures initialized tracked submodules without counting their directory entries", async () => {
    const root = await repo(),
      source = await repo()
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "child")
    git(root, "commit", "-qm", "submodule")
    const c = await capture(root, "editor")
    await writeFile(path.join(root, "child", "a.ts"), "submodule edit\n")
    const changes = (await c.finish()).changes
    expect(changes).toHaveLength(1)
    expect(changes[0].absPath).toBe(path.join(root, "child", "a.ts"))
    expect(changes[0].before?.toString()).toBe("const a = 1\n")
  })

  it("does not observe files outside a selected workspace subdirectory", async () => {
    const root = await repo(),
      workspace = path.join(root, "selected")
    await mkdir(workspace)
    await writeFile(path.join(workspace, "in.ts"), "inside\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "workspace")
    const c = await beginShellFileCapture({
      workspaceRoot: workspace,
      cwd: root,
      command: "editor",
      isCodeFile: (p) => p.endsWith(".ts")
    })
    await writeFile(path.join(root, "a.ts"), "outside\n")
    await writeFile(path.join(workspace, "in.ts"), "new inside\n")
    expect((await c!.finish()).changes.map((x) => x.absPath)).toEqual([
      path.join(workspace, "in.ts")
    ])
  })

  it("falls back to attribution-only when the dirty-preimage byte budget is exhausted", async () => {
    const root = await repo()
    await writeFile(path.join(root, "a.ts"), "dirty and larger than budget\n")
    const c = await capture(root, "editor", { snapshotBytes: 4 })
    await writeFile(path.join(root, "a.ts"), "new value\n")
    expect((await c.finish()).changes[0].decision).toBe("attributed")
  })
})
