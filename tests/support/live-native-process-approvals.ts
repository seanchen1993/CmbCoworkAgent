/** Test-only presentation bridge. Every native process still needs an exact external review. */
export function installLiveNativeProcessApprovals(
  { app, dialog }: Pick<typeof import("electron"), "app" | "dialog">,
  setup: { isolated: string; workspace: string }
): void {
  ;(globalThis as unknown as Record<string, unknown>)["__name"] = (value: unknown) => value
  const fs = process.getBuiltinModule("fs")
  const paths = process.getBuiltinModule("path")
  const crypto = process.getBuiltinModule("crypto")
  const digest = (bytes: string) => crypto.createHash("sha256").update(bytes).digest("hex")
  const isolated = fs.realpathSync(setup.isolated)
  const workspace = fs.realpathSync(setup.workspace)
  const userData = fs.realpathSync(app.getPath("userData"))
  const below = (root: string, file: string) => {
    const tail = paths.relative(root, file)
    return !paths.isAbsolute(tail) && tail !== ".." && !tail.startsWith(".." + paths.sep)
  }
  if (!below(isolated, workspace) || !below(isolated, userData))
    throw Error("LIVE_NATIVE_APPROVAL_ISOLATION_REQUIRED")
  const ordinary = (file: string) => {
    const info = fs.lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw Error("LIVE_NATIVE_APPROVAL_GIT_LINK_INVALID")
    return fs.readFileSync(file, "utf8").trim()
  }
  const scope = (directory: unknown) => {
    if (typeof directory !== "string") throw Error("LIVE_NATIVE_APPROVAL_WORKSPACE_REQUIRED")
    const cwd = fs.realpathSync(directory)
    if (below(workspace, cwd)) return { kind: "workspace", cwd }
    const managed = paths.join(isolated, "data", "worktrees")
    if (
      !fs.existsSync(managed) ||
      fs.lstatSync(managed).isSymbolicLink() ||
      fs.realpathSync(managed) !== managed ||
      !below(managed, cwd) ||
      cwd === managed
    )
      throw Error("LIVE_NATIVE_APPROVAL_WORKSPACE_REQUIRED")
    const gitFile = paths.join(cwd, ".git")
    const link = /^gitdir: ([^\r\n]+)$/.exec(ordinary(gitFile))?.[1]
    if (!link) throw Error("LIVE_NATIVE_APPROVAL_GIT_LINK_INVALID")
    const common = fs.realpathSync(paths.join(workspace, ".git"))
    if (fs.lstatSync(paths.join(workspace, ".git")).isSymbolicLink() || !below(workspace, common))
      throw Error("LIVE_NATIVE_APPROVAL_GIT_LINK_INVALID")
    const gitDir = fs.realpathSync(paths.resolve(cwd, link))
    if (!below(paths.join(common, "worktrees"), gitDir))
      throw Error("LIVE_NATIVE_APPROVAL_GIT_LINK_INVALID")
    if (
      fs.realpathSync(paths.resolve(gitDir, ordinary(paths.join(gitDir, "commondir")))) !==
        common ||
      fs.realpathSync(paths.resolve(gitDir, ordinary(paths.join(gitDir, "gitdir")))) !==
        fs.realpathSync(gitFile)
    )
      throw Error("LIVE_NATIVE_APPROVAL_GIT_LINK_INVALID")
    return { kind: "managed-worktree", cwd, gitDir, common }
  }
  const reviews = paths.join(isolated, "native-dialog-reviews")
  if (!fs.existsSync(reviews)) fs.mkdirSync(reviews, { recursive: false })
  if (
    !fs.lstatSync(reviews).isDirectory() ||
    fs.lstatSync(reviews).isSymbolicLink() ||
    fs.realpathSync(reviews) !== reviews
  )
    throw Error("LIVE_NATIVE_APPROVAL_REVIEW_DIRECTORY_INVALID")
  // Same-run restart must allocate a fresh identity even for an identical native command.
  let sequence = 0
  for (const entry of fs.readdirSync(reviews, { withFileTypes: true })) {
    const match = /^([1-9][0-9]*)\.(?:proposal|decision|rejected)\.json$/.exec(entry.name)
    const id = Number(match?.[1])
    if (!entry.isFile() || !match || !Number.isSafeInteger(id) || id >= Number.MAX_SAFE_INTEGER)
      throw Error("LIVE_NATIVE_APPROVAL_REVIEW_SEQUENCE_INVALID")
    sequence = Math.max(sequence, id)
  }
  const original = dialog.showMessageBox
  dialog.showMessageBox = ((...args: unknown[]) => {
    const options = args.at(-1) as import("electron").MessageBoxOptions
    if (options.title !== "批准插件运行本机命令") return Reflect.apply(original, dialog, args)
    if (!Number.isSafeInteger(sequence + 1)) return Promise.resolve({ response: 0 })
    const id = ++sequence
    const write = (name: string, value: unknown) =>
      fs.writeFileSync(paths.join(reviews, `${id}.${name}.json`), JSON.stringify(value, null, 2), { flag: "wx" })
    try {
      if (
        JSON.stringify(options.buttons) !== JSON.stringify(["拒绝", "允许本次命令", "查看完整请求"])
      )
        throw Error("LIVE_NATIVE_APPROVAL_BUTTONS_CHANGED")
      const requestDigest = /完整请求 SHA-256：([a-f0-9]{64})/.exec(options.detail ?? "")?.[1]
      if (!requestDigest) throw Error("LIVE_NATIVE_APPROVAL_DIGEST_MISSING")
      const matches = fs
        .readdirSync(userData)
        .filter((name) => name.startsWith("cmb-process-review-"))
        .flatMap((name) => {
          const directory = paths.join(userData, name)
          const file = paths.join(directory, "request.json")
          if (
            fs.lstatSync(directory).isSymbolicLink() ||
            !fs.existsSync(file) ||
            fs.lstatSync(file).isSymbolicLink() ||
            !below(userData, fs.realpathSync(file))
          )
            return []
          const bytes = fs.readFileSync(file, "utf8")
          return digest(bytes) === requestDigest ? [{ request: JSON.parse(bytes), file }] : []
        })
      if (matches.length !== 1) throw Error("LIVE_NATIVE_APPROVAL_REQUEST_AMBIGUOUS")
      const request = matches[0].request
      const workspaceProof = scope(request.cwd)
      const proposal = {
        id,
        title: options.title,
        message: options.message,
        detail: options.detail,
        buttons: options.buttons,
        requestDigest,
        request,
        workspaceProof
      }
      const reviewDigest = digest(JSON.stringify(proposal))
      const pending = { digest: reviewDigest, proposal }
      write("proposal", pending)
      fs.writeFileSync(
        paths.join(isolated, "pending-native-approval.json"),
        JSON.stringify(pending, null, 2)
      )
      return new Promise((resolve) => {
        const timer = setInterval(() => {
          let decision: "approve" | "reject" | undefined
          let reason = "exact-reviewed-request"
          try {
            if (options.signal?.aborted) {
              decision = "reject"
              reason = "native-aborted"
            } else {
              const path = paths.join(isolated, "reviewed-approvals.json")
              if (!fs.existsSync(path)) return
              const reviewed = JSON.parse(fs.readFileSync(path, "utf8"))
              if (!reviewed || Array.isArray(reviewed) || typeof reviewed !== "object") return
              if (!Object.hasOwn(reviewed, reviewDigest)) return
              const value = reviewed[reviewDigest]
              if (value !== "approve" && value !== "reject") return
              decision = value
              if (JSON.stringify(scope(request.cwd)) !== JSON.stringify(workspaceProof))
                throw Error("LIVE_NATIVE_APPROVAL_WORKSPACE_CHANGED")
              if (digest(fs.readFileSync(matches[0].file, "utf8")) !== requestDigest) {
                decision = "reject"
                reason = "native-request-changed"
              }
            }
          } catch {
            decision = "reject"
            reason = "review-unavailable"
          }
          clearInterval(timer)
          write("decision", { digest: reviewDigest, requestDigest, decision, reason })
          resolve({ response: decision === "approve" ? 1 : 0 })
        }, 100)
      })
    } catch (error) {
      write("rejected", {
        code: error instanceof Error ? error.message : "LIVE_NATIVE_APPROVAL_INVALID"
      })
      return Promise.resolve({ response: 0 })
    }
  }) as typeof dialog.showMessageBox
}
