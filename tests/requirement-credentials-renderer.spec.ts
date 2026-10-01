import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { randomUUID } from "node:crypto"
import ts from "typescript"
import { transform } from "esbuild"

async function main(): Promise<void> {
  const sentinel = "F02_RENDERER_FAKE_SECRET+/="
  const source = await readFile(
    resolve("src/renderer/src/components/requirement/RequirementConversationView.tsx"),
    "utf8"
  )
  const start = source.indexOf("  const handlePublishToRequirementSpace")
  const end = source.indexOf("  const handleOpenLeanstarTokenPage", start)
  assert(start >= 0 && end > start, "controlled action callback boundary exists")
  // Execute the actual production callbacks, not a separately reimplemented flow.
  const callbacks = ts.transpileModule(
    `${source.slice(start, end)}\nglobalThis.handlers = { handlePublishToRequirementSpace, handleConfirmRequirementPublish, handleConfigureLeanstarCredential, handleTokenDialogChange, handleConfirmLeanstarToken };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText
  const queues: unknown[] = [],
    logs: unknown[] = [],
    calls: Array<{ action: string; payload?: unknown }> = []
  const approval = {
    reqId: "req-a",
    threadId: "thread-a",
    requestId: "request-a",
    credentialRef: "cred-a",
    inputDigest: "fake-digest",
    expiresAt: 60_000
  }
  let preparationAvailable = false
  const sandbox: Record<string, any> = {
    useCallback: (callback: unknown) => callback,
    useEffect: () => undefined,
    threadState: { addQueuedMessage: (message: unknown) => queues.push(message) },
    conversationLoading: false,
    requirementSpaceManifest: null,
    isRequirementSpacePublished: () => false,
    publishRequestQueuedRef: { current: false },
    threadId: "thread-a",
    requirement: { id: "req-a" },
    currentThreadIdRef: { current: "thread-a" },
    tokenDraft: sentinel,
    publishApproval: null,
    setPublishRequestQueued: () => undefined,
    setPublishApproval: (value: unknown) => {
      sandbox.publishApproval = value
    },
    setTokenDraft: (value: string) => {
      sandbox.tokenDraft = value
    },
    setTokenDialogOpen: (value: boolean) => {
      sandbox.tokenDialogOpen = value
    },
    setTokenSaving: () => undefined,
    setHasStoredToken: () => undefined,
    loadRequirementSpaceManifest: async () => undefined,
    toast: {
      error: (value: unknown) => logs.push(value),
      success: (value: unknown) => logs.push(value)
    },
    crypto: { randomUUID },
    window: {
      api: {
        requirements: {
          saveToken: async (token: string) => {
            assert(token === sentinel)
            calls.push({ action: "save" })
            return { success: true, configured: true, credentialRef: "cred-a" }
          },
          preparePublish: async (payload: unknown) => {
            calls.push({ action: "prepare", payload })
            return preparationAvailable
              ? { success: true, approval }
              : {
                  success: false,
                  code: "CAPABILITY_UNAVAILABLE",
                  error: "发布连接器尚未配置，无法发布"
                }
          },
          confirmPublish: async (payload: unknown) => {
            calls.push({ action: "confirm", payload })
            return { success: true, published: true }
          }
        }
      }
    }
  }
  runInNewContext(callbacks, sandbox)
  await sandbox.handlers.handleConfirmLeanstarToken()
  assert.equal(sandbox.tokenDraft, "", "saved credential draft is cleared")
  assert.equal(sandbox.tokenDialogOpen, false)
  sandbox.tokenDraft = sentinel
  sandbox.handlers.handleTokenDialogChange(false)
  assert.equal(sandbox.tokenDraft, "", "cancelled credential draft is cleared")
  sandbox.handlers.handleConfigureLeanstarCredential()
  assert.equal(sandbox.tokenDialogOpen, true, "configuration opens password input only")
  await sandbox.handlers.handlePublishToRequirementSpace()
  assert.equal(sandbox.publishApproval, null, "production unavailable does not offer false success")
  preparationAvailable = true
  await sandbox.handlers.handlePublishToRequirementSpace()
  assert.equal(
    calls.filter((call) => call.action === "confirm").length,
    0,
    "prepare never auto-confirms"
  )
  assert.equal(sandbox.publishApproval.approval.inputDigest, approval.inputDigest)
  await sandbox.handlers.handleConfirmRequirementPublish()
  assert.equal(
    calls.filter((call) => call.action === "confirm").length,
    1,
    "explicit confirm callback invokes controlled entry"
  )
  assert.equal(sandbox.publishApproval, null)
  sandbox.tokenDraft = sentinel
  sandbox.window.api.requirements.saveToken = async () => {
    throw new Error(sentinel)
  }
  await sandbox.handlers.handleConfirmLeanstarToken()
  assert.equal(sandbox.tokenDraft, "", "failed save clears draft and sanitizes exception")
  assert.equal(queues.length, 0, "credential and publication actions never enqueue a chat message")
  const simulatedModelSessionMemory = {
    queuedMessages: queues,
    modelPayload: queues,
    sessionPayload: queues,
    memoryPayload: queues,
    logs,
    calls
  }
  assert(
    !JSON.stringify(simulatedModelSessionMemory).includes(sentinel),
    "sentinel cannot enter logs or ordinary conversation/model/session/memory payloads"
  )
  assert(source.includes('type="password"'), "credential input is password masked")

  const apiSource = await readFile(resolve("src/renderer/src/api/leanstar-requirements.ts"), "utf8")
  async function loadApi(mock: boolean): Promise<any> {
    const compiled = await transform(apiSource, {
      loader: "ts",
      format: "cjs",
      target: "es2022",
      define: {
        "import.meta.env.DEV": String(mock),
        "import.meta.env.VITE_LEANSTAR_REQUIREMENTS_MOCK": '"false"'
      }
    })
    const module = { exports: {} }
    runInNewContext(compiled.code, {
      module,
      exports: module.exports,
      fetch: () => {
        throw new Error("renderer network must not be used")
      },
      window: {
        api: {
          requirements: {
            queryLeanstar: async (query: any) => {
              calls.push({ action: "query", payload: query })
              const data =
                query.operation === "listProductRequirements"
                  ? { body: { content: [{ code: "safe" }], total: 1 } }
                  : query.operation === "getRequirementDetail"
                    ? { returnCode: "0", body: { title: "safe" } }
                    : query.operation === "getRequirementDocumentContent"
                      ? { body: { documentTextContent: "safe" } }
                      : { content: [], total: 0 }
              return { success: true, data }
            }
          }
        }
      }
    })
    return (module.exports as any).leanstarRequirementsApi
  }
  const api = await loadApi(false)
  await api.listDigitalProducts()
  assert.equal((await api.listProductRequirements("org-a", "ORG")).content[0].code, "safe")
  await api.getImplementationDetail("PR-1")
  assert.equal((await api.getRequirementDetail("PR-1")).title, "safe")
  assert.equal((await api.getRequirementDocumentContent("PR-1")).documentTextContent, "safe")
  await api.getNamespaceTree()
  assert.deepEqual(
    calls.filter((call) => call.action === "query").map((call) => (call.payload as any).operation),
    [
      "listDigitalProducts",
      "listProductRequirements",
      "getImplementationDetail",
      "getRequirementDetail",
      "getRequirementDocumentContent",
      "getNamespaceTree"
    ]
  )
  const mock = await loadApi(true),
    before = calls.length
  assert((await mock.listDigitalProducts()).content.length > 0)
  await mock.getNamespaceTree()
  assert.equal(calls.length, before, "developer demonstration mock stays local")
  console.log(
    "requirement-credentials-renderer: controlled action and six-operation boundary assertions passed"
  )
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
