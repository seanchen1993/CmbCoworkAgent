/** Test-only exact native dialog validation. This never performs or substitutes a file write. */
export function nativeModFileApprovalDecision(input: {
  ownerMatches: boolean
  aborted: boolean
  used: boolean
  title?: string
  message?: string
  modId: string
  actualPath: string
  expectedPath: string
  actualContent: unknown
  expectedContent: string
}): { response: 0 | 1; reason: string } {
  if (!input.ownerMatches) return { response: 0, reason: "foreign-owner" }
  if (input.aborted) return { response: 0, reason: "native-aborted" }
  if (input.used) return { response: 0, reason: "already-approved" }
  if (
    input.title !== "批准插件操作" ||
    input.message !== `插件 ${input.modId} 请求执行 host:write_file`
  )
    return { response: 0, reason: "unexpected-operation" }
  if (!input.actualPath || input.actualPath !== input.expectedPath)
    return { response: 0, reason: "unexpected-path" }
  if (!input.expectedContent || input.actualContent !== input.expectedContent)
    return { response: 0, reason: "unexpected-content" }
  return { response: 1, reason: "exact-original-report-write" }
}

/** Mirrors only the frozen consumer's pure JSON projection, from the actual copied bytes.
 * Hash consistency and this local sample's totals do not grant business acceptance. */
export function nativeVerifiedReportText(
  content: string,
  digest: (text: string) => string
): string {
  if (typeof content !== "string" || content.length > 262144) throw Error("INVALID_BUNDLE")
  const bundle = JSON.parse(content) as {
    apiVersion: string
    producer: {
      compositionRunId: string
      unitId: string
      engineRunId: string
      source: { pluginId: string; packageDigest: string }
      evidenceDigest: string
    }
    files: Array<{
      id: string
      path: string
      digest: string
      content: string
      outputNodeId: string
      checkedBy: { nodeId: string; checkId: string; contractDigest: string }
    }>
  }
  if (
    bundle.apiVersion !== "devclaw.autobiz-context/v1" ||
    !bundle.producer ||
    !Array.isArray(bundle.files) ||
    bundle.files.length !== 2
  )
    throw Error("INVALID_BUNDLE")
  const requiredIds = ["warehouse_sql_results", "warehouse_quality"]
  const seen = new Set<string>()
  const artifacts = bundle.files.map((file) => {
    if (
      !requiredIds.includes(file.id) ||
      seen.has(file.id) ||
      typeof file.content !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.digest) ||
      digest(file.content) !== file.digest ||
      !file.outputNodeId ||
      !file.checkedBy?.nodeId ||
      !file.checkedBy.checkId ||
      !/^[a-f0-9]{64}$/.test(file.checkedBy.contractDigest)
    )
      throw Error("INVALID_ARTIFACT")
    seen.add(file.id)
    const value = JSON.parse(file.content)
    if (file.id === "warehouse_sql_results" && value.validAmountCents !== 43575)
      throw Error("UNEXPECTED_SQL_RESULT")
    if (
      file.id === "warehouse_quality" &&
      (value.qualityStatus !== "passed" ||
        value.summary?.validAmountCents !== 43575 ||
        value.businessAcceptance !== "needs_review" ||
        value.productionAcceptance !== "not_evaluated")
    )
      throw Error("UNEXPECTED_QUALITY_RESULT")
    return {
      id: file.id,
      path: file.path,
      digest: file.digest,
      outputNodeId: file.outputNodeId,
      checkedBy: file.checkedBy,
      value
    }
  })
  if (requiredIds.some((id) => !seen.has(id))) throw Error("MISSING_ARTIFACT")
  return (
    JSON.stringify(
      {
        bundleDigest: digest(content),
        producer: bundle.producer,
        requiredIds,
        artifacts,
        acceptance:
          "producer-checked-content; consumer consistency only; business acceptance remains unchanged"
      },
      null,
      2
    ) + "\n"
  )
}

export interface NativeModFileApprovalSetup {
  ownerId: number
  producerWorkspace: string
  consumerWorkspace: string
  validator: string
  projector: string
}

/** The sole native callback used both by Playwright and the complete isolated VM probe. */
export function installNativeModFileApproval(
  { dialog, BrowserWindow }: Pick<typeof import("electron"), "dialog" | "BrowserWindow">,
  setup: NativeModFileApprovalSetup
): void {
  ;(globalThis as unknown as Record<string, unknown>)["__name"] = Function("value", "return value")
  const fs = process.getBuiltinModule("node:fs")
  const paths = process.getBuiltinModule("node:path")
  const crypto = process.getBuiltinModule("node:crypto")
  const validate = new Function("__name", "return (" + setup.validator + ")")(
    (value: unknown) => value
  ) as typeof nativeModFileApprovalDecision
  const reportText = new Function("__name", "return (" + setup.projector + ")")(
    (value: unknown) => value
  ) as typeof nativeVerifiedReportText
  const expectedOwner = BrowserWindow.fromId(setup.ownerId)
  if (!expectedOwner || expectedOwner.isDestroyed()) throw Error("NATIVE_APPROVAL_OWNER_MISSING")
  const producerRoot = fs.realpathSync(setup.producerWorkspace)
  const consumerRoot = fs.realpathSync(setup.consumerWorkspace)
  const expectedPath = paths.join(consumerRoot, "consumed-report.json")
  const normalize = (value: string) => paths.resolve(value).toLowerCase()
  const requests: Array<Record<string, unknown>> = []
  ;(globalThis as unknown as { __a12NativeFileApprovals: unknown[] }).__a12NativeFileApprovals =
    requests
  let used = false
  dialog.showMessageBox = (async (owner, options) => {
    let validation = { response: 0 as 0 | 1, reason: "invalid-native-request" }
    let args: Record<string, unknown> | undefined
    let bundleDigest: string | undefined
    try {
      if (!options || typeof options.detail !== "string") throw Error("INVALID_NATIVE_DETAIL")
      // The original detail is an optional reason followed by the exact JSON arguments.
      const offset = options.detail.indexOf("{")
      if (offset < 0) throw Error("INVALID_NATIVE_DETAIL")
      args = JSON.parse(options.detail.slice(offset)) as Record<string, unknown>
      const keys = Object.keys(args).sort().join(",")
      if (keys !== "content,file_path" && keys !== "content,filePath")
        throw Error("INVALID_NATIVE_ARGUMENTS")
      const file = args.file_path ?? args.filePath
      if (typeof file !== "string") throw Error("INVALID_NATIVE_PATH")
      if (
        fs.realpathSync(consumerRoot) !== consumerRoot ||
        fs.realpathSync(producerRoot) !== producerRoot
      )
        throw Error("NATIVE_ROOT_CHANGED")
      const copiedPath = paths.join(consumerRoot, "inputs/verified-context.json")
      const producedPath = paths.join(producerRoot, ".devclaw/handoffs/verified-context.json")
      for (const path of [copiedPath, producedPath]) {
        const stat = fs.lstatSync(path)
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size > 262144 ||
          fs.realpathSync(path) !== path
        )
          throw Error("UNSAFE_NATIVE_INPUT")
      }
      const bytes = fs.readFileSync(copiedPath)
      if (!bytes.equals(fs.readFileSync(producedPath))) throw Error("NATIVE_INPUT_MISMATCH")
      const digest = (text: string) => crypto.createHash("sha256").update(text).digest("hex")
      bundleDigest = digest(bytes.toString("utf8"))
      const expectedContent = reportText(bytes.toString("utf8"), digest)
      validation = validate({
        ownerMatches: owner === expectedOwner && !expectedOwner.isDestroyed(),
        aborted: options.signal?.aborted === true,
        used,
        title: options.title,
        message: options.message,
        modId: "function:verified-artifact-consumer",
        actualPath: normalize(paths.resolve(consumerRoot, file)),
        expectedPath: normalize(expectedPath),
        actualContent: args.content,
        expectedContent
      })
    } catch (error) {
      validation = {
        response: 0,
        reason: error instanceof Error ? error.message : "INVALID_NATIVE_REQUEST"
      }
    }
    if (validation.response === 1) used = true
    requests.push({
      ownerId: owner?.id,
      title: options?.title,
      message: options?.message,
      detail: options?.detail,
      buttons: options?.buttons,
      args,
      bundleDigest,
      validation,
      response: validation.response,
      aborted: options?.signal?.aborted === true,
      mechanism: "Bounded original Electron native dialog harness; not OS human acceptance"
    })
    return { response: validation.response, checkboxChecked: false }
  }) as typeof dialog.showMessageBox
}
