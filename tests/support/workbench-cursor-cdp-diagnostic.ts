import assert from "node:assert/strict"
import type { Page } from "playwright"

/** Explicit diagnostic only. Breakpoints pause JavaScript; these samples cannot qualify performance. */
export async function startWorkbenchCursorCdpDiagnostic(input: {
  page: Page
  selector: string
  expectedText: string
  record(kind: string, value: unknown): void
}): Promise<() => Promise<void>> {
  const session = await input.page.context().newCDPSession(input.page)
  const objectGroup = "owned-workbench-cursor-diagnostic"
  const scripts = new Map<string, string>()
  const tasks = new Set<Promise<void>>()
  const observations: unknown[] = [],
    failures: string[] = []
  let breakpointId: string | undefined,
    nodeId: number | undefined,
    captureId: string | undefined,
    stopping = false,
    stopPromise: Promise<void> | undefined,
    paused = 0,
    limit: string | undefined
  const selector = JSON.stringify(input.selector)
  const current = `document.querySelector(${selector})`
  const stop = () => {
    if (stopPromise) return stopPromise
    stopping = true
    clearTimeout(timer)
    stopPromise = (async () => {
      const cleanup = async (label: string, work: () => Promise<unknown>) => {
        try {
          await work()
        } catch (error) {
          failures.push(`${label}:${String(error)}`)
        }
      }
      // Resume even when setup, capture, or a protocol request failed mid-pause.
      await session.send("Debugger.resume").catch(() => {})
      await Promise.allSettled([...tasks])
      if (breakpointId)
        await cleanup("remove-function-breakpoint", () =>
          session.send("Debugger.removeBreakpoint", { breakpointId: breakpointId! })
        )
      if (nodeId)
        await cleanup("remove-owned-DOM-breakpoint", () =>
          session.send("DOMDebugger.removeDOMBreakpoint", {
            nodeId: nodeId!,
            type: "subtree-modified"
          })
        )
      await cleanup("disable-debugger", () => session.send("Debugger.disable"))
      let identity: unknown = null
      if (captureId)
        await cleanup("original-accessor-identity", async () => {
          const result = await session.send("Runtime.callFunctionOn", {
            objectId: captureId,
            functionDeclaration: `function(selector) {
            const node = document.querySelector(selector)
            const descriptor = node && Object.getOwnPropertyDescriptor(node, 'value')
            return {sameNode:node === this.node,
              sameGetter:descriptor?.get === this.descriptor?.get,
              sameSetter:descriptor?.set === this.descriptor?.set,
              sameConfigurable:descriptor?.configurable === this.descriptor?.configurable,
              sameEnumerable:descriptor?.enumerable === this.descriptor?.enumerable}
          }`,
            arguments: [{ value: input.selector }],
            returnByValue: true,
            silent: true
          })
          identity = result.result.value
          assert(
            identity &&
              typeof identity === "object" &&
              Object.values(identity).every((value) => value === true),
            "OWNED_CDP_ACCESSOR_IDENTITY_CHANGED"
          )
        })
      await cleanup("release-diagnostic-references", () =>
        session.send("Runtime.releaseObjectGroup", { objectGroup })
      )
      await cleanup("detach-diagnostic-session", () => session.detach())
      input.record("owned-composer-CDP-diagnostic", {
        diagnosticOnly: true,
        scope:
          "Only the existing owned textarea accessor and its child text; no argument, input text or other frame locals recorded",
        paused,
        limit: limit ?? null,
        observations,
        originalAccessorIdentity: identity,
        failures
      })
      assert.equal(failures.length, 0, "OWNED_CDP_DIAGNOSTIC_CLEANUP_FAILED")
    })()
    return stopPromise
  }
  session.on("Debugger.scriptParsed", (event) => {
    if (scripts.size < 4096) scripts.set(event.scriptId, event.url)
  })
  session.on("Debugger.paused", (event) => {
    const task = (async () => {
      try {
        if (stopping) return
        if (++paused > 32) {
          limit = "32-pause-limit"
          void stop().catch(() => {})
          return
        }
        const ownSetter = Boolean(breakpointId && event.hitBreakpoints?.includes(breakpointId))
        const dom = event.data as { nodeId?: unknown; type?: unknown } | undefined
        const ownDom =
          event.reason === "DOM" &&
          nodeId !== undefined &&
          dom?.nodeId === nodeId &&
          dom.type === "subtree-modified"
        if (!ownSetter && !ownDom) return
        const result = await session.send("Debugger.evaluateOnCallFrame", {
          callFrameId: event.callFrames[0].callFrameId,
          expression: `(() => {const node=${current};return {
            ownedSetterThis:this === node,ownedNodePresent:node instanceof HTMLTextAreaElement,
            start:node?.selectionStart,end:node?.selectionEnd,
            sameDraft:node?.value === ${JSON.stringify(input.expectedText)},
            focused:document.activeElement === node,disabled:node?.disabled,readOnly:node?.readOnly}})()`,
          returnByValue: true,
          silent: true
        })
        const facts = result.result.value as { ownedSetterThis?: boolean } | undefined
        // Functions compiled from React's accessor source may be shared across other nodes.
        if (ownSetter && facts?.ownedSetterThis !== true) return
        observations.push({
          kind: ownSetter ? "existing-owned-value-setter" : "owned-textarea-subtree",
          at: Date.now(),
          facts,
          stack: event.callFrames.slice(0, 16).map((frame) => ({
            function: frame.functionName,
            url: frame.url || scripts.get(frame.location.scriptId) || "",
            line: frame.location.lineNumber + 1,
            column:
              frame.location.columnNumber === undefined ? null : frame.location.columnNumber + 1
          }))
        })
      } catch (error) {
        failures.push(`capture:${String(error)}`)
      } finally {
        await session.send("Debugger.resume").catch(() => {})
      }
    })().finally(() => tasks.delete(task))
    tasks.add(task)
  })
  const timer = setTimeout(() => {
    limit = "10-second-deadline"
    void stop().catch(() => {})
  }, 10_000)
  try {
    await session.send("Debugger.enable")
    const capture = await session.send("Runtime.evaluate", {
      expression: `({node:${current},descriptor:Object.getOwnPropertyDescriptor(${current},'value')})`,
      objectGroup,
      silent: true
    })
    captureId = capture.result.objectId
    assert(captureId, "OWNED_CDP_DESCRIPTOR_CAPTURE_REQUIRED")
    const setter = await session.send("Runtime.callFunctionOn", {
      objectId: captureId,
      functionDeclaration: "function() {return this.descriptor?.set}",
      objectGroup,
      silent: true
    })
    assert(
      setter.result.objectId && setter.result.type === "function",
      "OWNED_CDP_EXISTING_JS_SETTER_REQUIRED"
    )
    ;({ breakpointId } = await session.send("Debugger.setBreakpointOnFunctionCall", {
      objectId: setter.result.objectId,
      condition: `this === ${current}`
    }))
    await session.send("DOM.enable")
    await session.send("DOM.getDocument")
    const target = await session.send("Runtime.callFunctionOn", {
      objectId: captureId,
      functionDeclaration: "function() {return this.node}",
      objectGroup,
      silent: true
    })
    assert(target.result.objectId, "OWNED_CDP_TEXTAREA_REQUIRED")
    ;({ nodeId } = await session.send("DOM.requestNode", { objectId: target.result.objectId }))
    assert(nodeId, "OWNED_CDP_DOM_NODE_REQUIRED")
    await session.send("DOMDebugger.setDOMBreakpoint", { nodeId, type: "subtree-modified" })
    return stop
  } catch (error) {
    await stop().catch(() => {})
    throw error
  }
}
