import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import ts from "typescript"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  classifyPhysicalStreamRunFailure,
  physicalStreamRunHasSuccessor
} from "../agent/physical-stream-run-setup"
import { runSettlementPhases } from "../agent/run-settlement-fence"
import {
  clearCurrentRunMessageQueue,
  isCurrentRunMessageQueueOwner,
  setCurrentRunMessageQueueOwner
} from "../agent/current-run-message-queue"

type ExitApi = {
  eligible(): void
  cancel(branch: number): void
  success(): void
  publish(): void
}
type Route = {
  managed?: boolean
  otherSource?: boolean
  plugin?: boolean
  internal?: boolean
  workflow?: boolean
  ambient?: boolean
}

const file = ts.createSourceFile(
  "agent.ts",
  readFileSync(resolve("src/main/ipc/agent.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true
)
const nodes: ts.Node[] = []
function visit(node: ts.Node): void {
  nodes.push(node)
  ts.forEachChild(node, visit)
}
visit(file)
function assignment(name: string): ts.ExpressionStatement[] {
  return nodes.filter(
    (node): node is ts.ExpressionStatement =>
      ts.isExpressionStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.expression.left) &&
      node.expression.left.text === name
  )
}
function sourceExits() {
  const names = ["cancellationTerminalPending", "invokeDoneAttempted", "cancelledRequestEligible"]
  const declarations = nodes.filter(
    (node): node is ts.VariableStatement =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)
      )
  )
  const eligible = assignment("cancelledRequestEligible")
  const cancelled = assignment("cancellationTerminalPending")
  const publication = nodes.filter(
    (node): node is ts.IfStatement =>
      ts.isIfStatement(node) &&
      node.expression.getText(file).startsWith("cancellationTerminalPending &&")
  )
  const successful = assignment("invokeDoneAttempted").filter(
    (node) => node.parent !== publication[0]?.thenStatement
  )
  const helpers = file.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) &&
      !!node.name &&
      ["physicalRunHasSuccessor", "ownsPhysicalStreamRunLease"].includes(node.name.text)
  )
  if (
    declarations.length !== 3 ||
    eligible.length !== 1 ||
    cancelled.length !== 2 ||
    publication.length !== 1 ||
    successful.length !== 1 ||
    helpers.length !== 2
  )
    throw Error("Actual invoke cancellation source is missing or ambiguous")
  const successBlock = successful[0].parent
  if (!ts.isBlock(successBlock)) throw Error("Actual success block required")
  const successIndex = successBlock.statements.indexOf(successful[0])
  const successSend = successBlock.statements[successIndex + 1]
  if (
    !successSend ||
    !successSend.getText(file).includes('safeSendToWindow(window, channel, { type: "done" })')
  )
    throw Error("The original success done must follow its attempted record")
  const finalBlock = publication[0].parent
  if (
    !ts.isBlock(finalBlock) ||
    !ts.isTryStatement(finalBlock.parent) ||
    finalBlock.parent.finallyBlock !== finalBlock
  )
    throw Error("Actual invoke finally publication required")
  const publicationIndex = finalBlock.statements.indexOf(publication[0])
  const settlement = finalBlock.statements[publicationIndex - 1]
  if (
    !settlement ||
    !ts.isExpressionStatement(settlement) ||
    !ts.isAwaitExpression(settlement.expression) ||
    !ts.isCallExpression(settlement.expression.expression) ||
    settlement.expression.expression.expression.getText(file) !== "settlePhysicalAgentRun"
  )
    throw Error("Publication must follow the actual awaited physical settlement")
  expect(settlement.getText(file)).toContain('kind: "invoke"')
  for (const branch of cancelled) {
    if (
      !ts.isBlock(branch.parent) ||
      !branch.parent.getText(file).includes("notifyManagedAgentRunCancelled")
    )
      throw Error("The actual cancellation branch is required")
  }
  return {
    declarations,
    eligible: eligible[0],
    cancelled,
    publication: publication[0],
    success: `${successful[0].getText(file)}\n${successSend.getText(file)}`,
    helpers
  }
}

const threads: string[] = []
afterEach(() => {
  for (const threadId of threads.splice(0)) clearCurrentRunMessageQueue(threadId)
})

// Execute the exact production assignments and terminal exit, without importing Electron startup.
// These are transport-boundary tests; the desktop focus proves actual IPC and physical cleanup.
function fixture(route: Route = {}) {
  const source = sourceExits(),
    threadId = randomUUID(),
    runToken = randomUUID()
  threads.push(threadId)
  const abortController = new AbortController()
  const activeRuns = new Map([[threadId, abortController]])
  const turnStates = new Map([[threadId, { runToken }]])
  setCurrentRunMessageQueueOwner(threadId, runToken)
  const channel = `agent:stream:${threadId}:request:${randomUUID()}`,
    window = {}
  const send = vi.fn()
  const code = ts.transpileModule(
    `
    const {threadId,runToken,abortController,activeRuns,turnStates,channel,window,
      safeSendToWindow,physicalStreamRunHasSuccessor,isCurrentRunMessageQueueOwner,route}=context;
    const runExecutionContext={source:route.otherSource?"im":"desktop"};
    const harnessAgentContext={managedExecution:!!route.managed};
    const pluginPrompt=route.plugin?{}:undefined;
    const isTrustedCoordinatorNotificationInvoke=!!route.internal;
    const isWorkflowNotificationInvoke=!!route.workflow;
    const streamRequestId=route.ambient?undefined:"actual-request";
    const isInternalNotificationTurn=!!route.internal;
    ${source.helpers.map((node) => node.getText(file)).join("\n")}
    ${source.declarations.map((node) => node.getText(file)).join("\n")}
    return {
      eligible(){${source.eligible.getText(file)}},
      cancel(branch){switch(branch){
        case 0:${source.cancelled[0].getText(file)};break;
        case 1:${source.cancelled[1].getText(file)};break;
        default:throw Error("Actual branch index required");}},
      success(){${source.success}},
      publish(){${source.publication.getText(file)}}
    };
  `,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText
  const create = new Function("context", code) as (context: object) => ExitApi
  const exits = create({
    threadId,
    runToken,
    abortController,
    activeRuns,
    turnStates,
    channel,
    window,
    safeSendToWindow: send,
    physicalStreamRunHasSuccessor,
    isCurrentRunMessageQueueOwner,
    route
  })
  const settle = async (operation: () => Promise<void>) => {
    await operation()
    exits.publish()
  }
  const cleanup = () =>
    runSettlementPhases({
      phases: [
        {
          name: "release-original-controller",
          run: () => {
            if (activeRuns.get(threadId) === abortController) activeRuns.delete(threadId)
            clearCurrentRunMessageQueue(threadId, runToken)
          }
        }
      ],
      resolveSettlement: () => {
        /* Original settlement has finished its phases. */
      }
    })
  return {
    exits,
    abortController,
    activeRuns,
    turnStates,
    threadId,
    runToken,
    channel,
    window,
    send,
    settle,
    cleanup
  }
}

describe("actual invoke cancelled request terminal exits", () => {
  it.each([0, 1])(
    "notifies branch %s only after actual settlement phases and once",
    async (branch) => {
      const f = fixture(),
        entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>()
      f.exits.eligible()
      f.abortController.abort()
      f.exits.cancel(branch)
      const settling = f.settle(async () => {
        await runSettlementPhases({
          phases: [
            {
              name: "held-real-phase",
              run: async () => {
                entered.resolve()
                await release.promise
              }
            }
          ],
          resolveSettlement: () => {
            /* This held phase has physically returned. */
          }
        })
        await f.cleanup()
      })
      try {
        await entered.promise
        expect(f.send).not.toHaveBeenCalled()
        release.resolve()
        await settling
        expect(f.send).toHaveBeenCalledExactlyOnceWith(f.window, f.channel, { type: "done" })
        f.exits.publish()
        expect(f.send).toHaveBeenCalledTimes(1)
      } finally {
        release.resolve()
        await Promise.allSettled([settling])
      }
    }
  )

  it.each(["controller", "token"])(
    "keeps the %s successor safe during settlement",
    async (kind) => {
      const f = fixture()
      f.exits.eligible()
      f.abortController.abort()
      f.exits.cancel(1)
      await f.settle(async () => {
        if (kind === "controller") f.activeRuns.set(f.threadId, new AbortController())
        else f.turnStates.set(f.threadId, { runToken: randomUUID() })
        await f.cleanup()
      })
      expect(f.send).not.toHaveBeenCalled()
    }
  )

  it("does not send a second done after a successful request later aborts", async () => {
    const f = fixture()
    f.exits.eligible()
    f.exits.success()
    f.abortController.abort()
    f.exits.cancel(1)
    await f.settle(f.cleanup)
    expect(f.send).toHaveBeenCalledExactlyOnceWith(f.window, f.channel, { type: "done" })
  })

  it("does not upgrade an abort-like error without an actually aborted signal", async () => {
    const f = fixture(),
      error = Object.assign(new Error("aborted"), { name: "AbortError" })
    f.exits.eligible()
    expect(classifyPhysicalStreamRunFailure({ ownsLease: true, signalAborted: false, error })).toBe(
      "cancelled"
    )
    f.exits.cancel(1)
    await f.settle(f.cleanup)
    expect(f.send).not.toHaveBeenCalled()
  })

  it("preserves early, managed, internal, plugin and ambient routes", async () => {
    for (const route of [
      {},
      { managed: true },
      { otherSource: true },
      { internal: true },
      { workflow: true },
      { plugin: true },
      { ambient: true }
    ]) {
      const f = fixture(route)
      if (Object.keys(route).length) f.exits.eligible()
      f.abortController.abort()
      f.exits.cancel(0)
      await f.settle(f.cleanup)
      expect(f.send).not.toHaveBeenCalled()
    }
  })

  it.each([new Error("ACTUAL_SETTLEMENT_REJECTED"), undefined])(
    "does not fabricate done after settlement rejects %s",
    async (reason) => {
      const f = fixture()
      f.exits.eligible()
      f.abortController.abort()
      f.exits.cancel(1)
      expect(
        await Promise.allSettled([
          f.settle(async () => {
            throw reason
          })
        ])
      ).toEqual([{ status: "rejected", reason }])
      expect(f.send).not.toHaveBeenCalled()
    }
  )
})
