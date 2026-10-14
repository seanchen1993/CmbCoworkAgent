import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { createMiddleware, type WrapModelCallHook } from "langchain"
import { createMemoryMiddleware, StateBackend } from "deepagents"
import { afterEach, expect, it } from "vitest"
import { ModRuntimeAuthorities, type ModRuntimeAuthority } from "../mods/runtime-instance"
import {
  createPromptSourceMiddleware,
  observePromptSourceMiddleware,
  promptContributionsFor,
  promptContextOccurrence,
  type PromptContribution
} from "./mods-prompt-sources"

type Middleware = Parameters<typeof observePromptSourceMiddleware>[0]
type Request = { systemMessage: SystemMessage; state?: Record<string, unknown> }
type HookResult = Awaited<ReturnType<WrapModelCallHook>>
const owners: ModRuntimeAuthorities[] = []
afterEach(() => owners.splice(0).forEach((owner) => owner.close()))

function authority(agentId = "main", turnId = "turn") {
  const manager = new ModRuntimeAuthorities()
  owners.push(manager)
  return {
    manager,
    ...manager.create({ workspace: "/sources", threadId: "thread", agentId, turnId })
  }
}

function parts(...values: Array<[string, string | null]>): PromptContribution[] {
  return values.map(([id, text]) => ({ id, text, scope: "session" }))
}

function source(owner: ModRuntimeAuthority, seed: readonly PromptContribution[]) {
  return createPromptSourceMiddleware({ authority: () => owner, seed: () => seed })
}

async function run(
  stack: Middleware[],
  message: SystemMessage,
  end: (request: Request) => void | Promise<void>,
  state?: Record<string, unknown>
): Promise<HookResult> {
  const invoke = async (index: number, request: Request): Promise<HookResult> => {
    const hook = stack[index]?.wrapModelCall as WrapModelCallHook | undefined
    if (!hook) {
      await end(request)
      return new AIMessage("done")
    }
    return hook(request as never, async (next) => {
      const value = await invoke(index + 1, next as Request)
      if (!(value instanceof AIMessage)) throw Error("Unexpected Command in model fixture handler")
      return value
    })
  }
  return invoke(0, { systemMessage: message, state })
}

function append(id: string | undefined, text: string) {
  return observePromptSourceMiddleware(
    createMiddleware({
      name: "append",
      wrapModelCall: (request, handler) =>
        handler({
          ...request,
          systemMessage: request.systemMessage.concat(text)
        })
    }),
    id
  )
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it("trusted copies retain a genuine occurrence and destructive rewrites lose it", async () => {
  const owner = authority().authority
  const context = { name: "claudeMd", instructionFiles: [] }
  const seed: PromptContribution[] = [{ id: "cmb:agents", text: "base", scope: "session", context }]
  await run([source(owner, seed), append("cmb:skills", "skill")], new SystemMessage("base"),
    ({ systemMessage }) => {
      const first = promptContributionsFor([systemMessage], owner)![0].context!
      const second = promptContributionsFor([systemMessage], owner)![0].context!
      expect(first).not.toBe(second)
      expect(promptContextOccurrence(first)).toBe(context)
      expect(promptContextOccurrence(second)).toBe(context)
    })
  const destructive = observePromptSourceMiddleware(createMiddleware({ name: "rewrite",
    wrapModelCall: (request, handler) => handler({ ...request, systemMessage: new SystemMessage("rewritten") })
  }))
  await run([source(owner, seed), destructive], new SystemMessage("base"), ({ systemMessage }) => {
    expect(promptContributionsFor([systemMessage], owner)).toBeUndefined()
  })
})

it("keeps seed null slots, exact separators, message identity and frozen copies", async () => {
  const owner = authority().authority
  const seed = parts(["cmb:agents", "agents\n\n"], ["cmb:extra", null], ["cmb:base", "base"])
  const message = new SystemMessage({
    content: "agents\n\nbase",
    id: "host-message",
    additional_kwargs: { host: true }
  })
  await run([source(owner, seed)], message, ({ systemMessage }) => {
    expect(systemMessage).toBe(message)
    const actual = promptContributionsFor([message, new HumanMessage("user")], owner)!
    expect(actual).toEqual(seed)
    expect(actual).not.toBe(seed)
    expect(actual[0]).not.toBe(seed[0])
    expect(Object.isFrozen(actual)).toBe(true)
    expect(Object.isFrozen(actual[0])).toBe(true)
    seed[0].text = "mutated host seed"
    expect(promptContributionsFor([message], owner)?.[0].text).toBe("agents\n\n")
  })
  expect(message.content).toBe("agents\n\nbase")
  expect(message.additional_kwargs).toEqual({ host: true })
})

it("records only the actual exact append and preserves lookalike headings as source text", async () => {
  const owner = authority().authority
  const message = new SystemMessage("## Memory\nexternal text")
  await run(
    [
      source(owner, parts(["cmb:extra", String(message.content)])),
      append("cmb:skills", "\n\nactual skills")
    ],
    message,
    ({ systemMessage }) => {
      expect(promptContributionsFor([systemMessage], owner)).toEqual(
        parts(["cmb:extra", "## Memory\nexternal text"], ["cmb:skills", "\n\nactual skills"])
      )
    }
  )
  expect(message.content).toBe("## Memory\nexternal text")
})

it("moves an existing null slot to its actual append position without duplicate ids", async () => {
  const owner = authority().authority
  await run(
    [
      source(owner, parts(["cmb:memory", null], ["cmb:base", "base"])),
      append("cmb:memory", "memory")
    ],
    new SystemMessage("base"),
    ({ systemMessage }) => {
      expect(promptContributionsFor([systemMessage], owner)).toEqual(
        parts(["cmb:base", "base"], ["cmb:memory", "memory"])
      )
    }
  )
})

it("observes the real native memory append without copying its template or changing blocks", async () => {
  const owner = authority().authority
  const native = createMemoryMiddleware({
    backend: new StateBackend({ state: {} }),
    sources: ["/MEMORY.md"]
  })
  await run(
    [
      source(owner, parts(["cmb:base", "base"])),
      observePromptSourceMiddleware(native, "cmb:memory")
    ],
    new SystemMessage("base"),
    ({ systemMessage }) => {
      const actual = promptContributionsFor([systemMessage], owner)!
      expect(actual[0]).toEqual({ id: "cmb:base", text: "base", scope: "session" })
      expect(actual[1].id).toBe("cmb:memory")
      expect(actual[1].text).toContain("ACTUAL MEMORY BODY")
      expect(Array.isArray(systemMessage.content)).toBe(true)
      expect(actual.map((part) => part.text ?? "").join("")).toBe(
        (systemMessage.content as Array<{ text: string }>).map((block) => block.text).join("")
      )
    },
    { memoryContents: { "/MEMORY.md": "ACTUAL MEMORY BODY" } }
  )
})

it("accepts a full-block append only with every original property intact", async () => {
  const owner = authority().authority
  const content = [{ type: "text" as const, text: "base", cache_control: { type: "ephemeral" } }]
  const message = new SystemMessage({ content })
  const native = createMiddleware({
    name: "blocks",
    wrapModelCall: (request, handler) =>
      handler({
        ...request,
        systemMessage: new SystemMessage({
          content: [
            ...(request.systemMessage.content as typeof content),
            { type: "text", text: "tail" }
          ]
        })
      })
  })
  await run(
    [source(owner, parts(["cmb:base", "base"])), observePromptSourceMiddleware(native, "cmb:tail")],
    message,
    ({ systemMessage }) => {
      expect(promptContributionsFor([systemMessage], owner)).toEqual(
        parts(["cmb:base", "base"], ["cmb:tail", "tail"])
      )
      expect((systemMessage.content as typeof content)[0]).toBe(content[0])
      expect(message.content).toBe(content)
      expect(content[0].cache_control).toEqual({ type: "ephemeral" })
    }
  )
})

it("does not accept flattened text equality when a prefix block property changed", async () => {
  const owner = authority().authority
  const native = createMiddleware({
    name: "changedCache",
    wrapModelCall: (request, handler) =>
      handler({
        ...request,
        systemMessage: new SystemMessage({
          content: [
            { type: "text", text: "base", cache_control: { type: "changed" } },
            { type: "text", text: "tail" }
          ]
        })
      })
  })
  await run(
    [
      source(owner, parts(["cmb:base", "base"], ["cmb:empty", null])),
      observePromptSourceMiddleware(native, "cmb:tail")
    ],
    new SystemMessage({
      content: [
        {
          type: "text",
          text: "base",
          cache_control: { type: "ephemeral" }
        }
      ]
    }),
    ({ systemMessage }) => {
      expect(promptContributionsFor([systemMessage], owner)).toBeUndefined()
    }
  )
})

it("does not name a string-to-block conversion that added properties to the original prefix", async () => {
  const owner = authority().authority
  const native = createMiddleware({
    name: "changedPrefix",
    wrapModelCall: (request, handler) =>
      handler({
        ...request,
        systemMessage: new SystemMessage({
          content: [
            { type: "text", text: "base", injected: true },
            { type: "text", text: "tail" }
          ]
        })
      })
  })
  await run(
    [source(owner, parts(["cmb:base", "base"])), observePromptSourceMiddleware(native, "cmb:tail")],
    new SystemMessage("base"),
    ({ systemMessage }) => expect(promptContributionsFor([systemMessage], owner)).toBeUndefined()
  )
})

it("forgets all old names and null slots after an unknown append, even before a known append", async () => {
  const owner = authority().authority
  await run(
    [
      source(owner, parts(["cmb:base", "base"], ["cmb:empty", null])),
      append(undefined, " unknown"),
      append("cmb:known", " known")
    ],
    new SystemMessage("base"),
    ({ systemMessage }) => {
      expect(systemMessage.content).toBe("base unknown known")
      expect(promptContributionsFor([systemMessage], owner)).toBeUndefined()
    }
  )
})

it("forgets sources for a declared destructive replacement without inspecting its headings", async () => {
  const owner = authority().authority
  const destructive = createMiddleware({
    name: "replace",
    wrapModelCall: (request, handler) =>
      handler({
        ...request,
        systemMessage: new SystemMessage("## Memory\nreplacement")
      })
  })
  await run(
    [
      source(owner, parts(["cmb:base", "base"], ["cmb:memory", null])),
      observePromptSourceMiddleware(destructive, "cmb:memory")
    ],
    new SystemMessage("base"),
    ({ systemMessage }) => expect(promptContributionsFor([systemMessage], owner)).toBeUndefined()
  )
})

it("keeps pass-through unknown middleware but rejects a repeated nonempty contribution id", async () => {
  const owner = authority().authority
  const pass = observePromptSourceMiddleware(
    createMiddleware({
      name: "pass",
      wrapModelCall: (request, handler) => handler(request)
    })
  )
  await run(
    [source(owner, parts(["cmb:base", "base"])), pass],
    new SystemMessage("base"),
    ({ systemMessage }) => {
      expect(promptContributionsFor([systemMessage], owner)).toEqual(parts(["cmb:base", "base"]))
    }
  )
  await run(
    [source(owner, parts(["cmb:base", "base"])), append("cmb:base", "tail")],
    new SystemMessage("base"),
    ({ systemMessage }) => {
      expect(promptContributionsFor([systemMessage], owner)).toBeUndefined()
    }
  )
})

it("rejects invalid seeds and source reconstruction mismatches without changing the payload", async () => {
  const owner = authority().authority
  for (const seed of [
    parts(["cmb:base", "wrong"]),
    parts(["cmb:base", "base"], ["cmb:base", null]),
    parts(["", "base"])
  ]) {
    const message = new SystemMessage("base")
    await run([source(owner, seed)], message, ({ systemMessage }) => {
      expect(systemMessage).toBe(message)
      expect(promptContributionsFor([systemMessage], owner)).toBeUndefined()
    })
  }
})

it("only consumes one matching pure-text system message and checks unobserved final changes", async () => {
  const owner = authority().authority
  const message = new SystemMessage("base")
  await run([source(owner, parts(["cmb:base", "base"]))], message, () => {
    expect(promptContributionsFor([], owner)).toBeUndefined()
    expect(promptContributionsFor([message, new SystemMessage("base")], owner)).toBeUndefined()
    expect(promptContributionsFor([new SystemMessage("changed")], owner)).toBeUndefined()
    expect(
      promptContributionsFor(
        [
          new SystemMessage({
            content: [
              { type: "text", text: "base" },
              { type: "image_url", image_url: "host-image" }
            ]
          })
        ],
        owner
      )
    ).toBeUndefined()
    expect(promptContributionsFor([message], owner)).toEqual(parts(["cmb:base", "base"]))
  })
})

it("snapshot comparison detects later in-place changes to content block properties", async () => {
  const owner = authority().authority
  const block = { type: "text" as const, text: "base", provenance: { revision: 1 } }
  const message = new SystemMessage({ content: [block] })
  await run([source(owner, parts(["cmb:base", "base"]))], message, () => {
    expect(promptContributionsFor([message], owner)).toEqual(parts(["cmb:base", "base"]))
    block.provenance.revision = 2
    expect(promptContributionsFor([message], owner)).toBeUndefined()
  })
})

it("isolates concurrent requests even when both use the exact same authority", async () => {
  const owner = authority().authority
  const entered = deferred()
  const release = deferred()
  let count = 0
  const entry = createPromptSourceMiddleware({
    authority: () => owner,
    seed: (request) => parts(["cmb:base", String(request.systemMessage.content)])
  })
  const observations: string[] = []
  await Promise.all(
    ["A", "B"].map((label) =>
      run(
        [entry, append("cmb:tail", label)],
        new SystemMessage(label),
        async ({ systemMessage }) => {
          if (++count === 2) entered.resolve()
          await entered.promise
          const actual = promptContributionsFor([systemMessage], owner)!
          observations.push(actual.map((part) => part.text).join(""))
          release.resolve()
          await release.promise
          expect(promptContributionsFor([systemMessage], owner)).toEqual(
            parts(["cmb:base", label], ["cmb:tail", label])
          )
        }
      )
    )
  )
  expect(observations.sort()).toEqual(["AA", "BB"])
})

it("forks each retry from the observer entry rather than a previous downstream branch", async () => {
  const owner = authority().authority
  const retry = observePromptSourceMiddleware(
    createMiddleware({
      name: "retry",
      wrapModelCall: async (request, handler) => {
        await handler({ ...request, systemMessage: request.systemMessage.concat(" first") })
        return handler({ ...request, systemMessage: request.systemMessage.concat(" second") })
      }
    }),
    "cmb:retry"
  )
  const seen: Array<readonly PromptContribution[]> = []
  await run(
    [source(owner, parts(["cmb:base", "base"])), retry, append("cmb:tail", " tail")],
    new SystemMessage("base"),
    ({ systemMessage }) => {
      seen.push(promptContributionsFor([systemMessage], owner)!)
    }
  )
  expect(seen).toEqual([
    parts(["cmb:base", "base"], ["cmb:retry", " first"], ["cmb:tail", " tail"]),
    parts(["cmb:base", "base"], ["cmb:retry", " second"], ["cmb:tail", " tail"])
  ])
})

it("does not share an observer frame between parallel downstream invocations", async () => {
  const owner = authority().authority
  const fanout = observePromptSourceMiddleware(
    createMiddleware({
      name: "fanout",
      wrapModelCall: async (request, handler) => {
        const results = await Promise.all(
          [" A", " B"].map((suffix) =>
            handler({
              ...request,
              systemMessage: request.systemMessage.concat(suffix)
            })
          )
        )
        return results[0]
      }
    }),
    "cmb:fanout"
  )
  const entered = deferred()
  let count = 0
  const seen: string[] = []
  await run(
    [source(owner, parts(["cmb:base", "base"])), fanout, append("cmb:tail", " tail")],
    new SystemMessage("base"),
    async ({ systemMessage }) => {
      if (++count === 2) entered.resolve()
      await entered.promise
      seen.push(
        promptContributionsFor([systemMessage], owner)!
          .map((part) => part.text)
          .join("")
      )
    }
  )
  expect(seen.sort()).toEqual(["base A tail", "base B tail"])
})

it("isolates nested owners and prevents a no-owner nested entry borrowing its parent", async () => {
  const parent = authority("main").authority
  const child = authority("mod-task:child").authority
  const parentMessage = new SystemMessage("parent")
  await run([source(parent, parts(["cmb:parent", "parent"]))], parentMessage, async () => {
    expect(promptContributionsFor([parentMessage], child)).toBeUndefined()
    await run(
      [source(child, parts(["cmb:child", "child"]))],
      new SystemMessage("child"),
      ({ systemMessage }) => {
        expect(promptContributionsFor([systemMessage], parent)).toBeUndefined()
        expect(promptContributionsFor([systemMessage], child)).toEqual(
          parts(["cmb:child", "child"])
        )
      }
    )
    await run(
      [
        createPromptSourceMiddleware({
          authority: () => undefined,
          seed: () => parts(["cmb:parent", "parent"])
        })
      ],
      parentMessage,
      ({ systemMessage }) => {
        expect(promptContributionsFor([systemMessage], parent)).toBeUndefined()
      }
    )
    expect(promptContributionsFor([parentMessage], parent)).toEqual(parts(["cmb:parent", "parent"]))
  })
})

it("cannot consume a snapshot after authority generation replacement or owner release", async () => {
  const instance = authority()
  const message = new SystemMessage("base")
  await run([source(instance.authority, parts(["cmb:base", "base"]))], message, () => {
    const replacement = instance.manager.create({
      workspace: "/sources",
      threadId: "thread",
      agentId: "main",
      turnId: "new-turn"
    })
    expect(promptContributionsFor([message], replacement.authority)).toBeUndefined()
    expect(promptContributionsFor([message], instance.authority)).toBeUndefined()
  })
  const current = instance.manager.get({
    workspace: "/sources",
    threadId: "thread",
    agentId: "main"
  })!
  await run([source(current, parts(["cmb:base", "base"]))], message, () => {
    instance.manager.closeThread("thread")
    expect(promptContributionsFor([message], current)).toBeUndefined()
  })
})

it("invalidates inherited async callbacks after their own model call has returned", async () => {
  const owner = authority().authority
  const later = deferred()
  const message = new SystemMessage("base")
  let inherited!: Promise<readonly PromptContribution[] | undefined>
  await run([source(owner, parts(["cmb:base", "base"]))], message, () => {
    inherited = later.promise.then(() => promptContributionsFor([message], owner))
    expect(promptContributionsFor([message], owner)).toEqual(parts(["cmb:base", "base"]))
  })
  later.resolve()
  expect(await inherited).toBeUndefined()
  expect(promptContributionsFor([message], owner)).toBeUndefined()
})

it("expires a returned retry branch even while a later branch and its outer request remain live", async () => {
  const owner = authority().authority
  const later = deferred()
  const secondEntered = deferred()
  const releaseSecond = deferred()
  let firstSnapshot!: Promise<readonly PromptContribution[] | undefined>
  const retry = observePromptSourceMiddleware(
    createMiddleware({
      name: "retryLifetime",
      wrapModelCall: async (request, handler) => {
        await handler({ ...request, systemMessage: request.systemMessage.concat(" first") })
        return handler({ ...request, systemMessage: request.systemMessage.concat(" second") })
      }
    }),
    "cmb:retry"
  )
  const running = run(
    [source(owner, parts(["cmb:base", "base"])), retry],
    new SystemMessage("base"),
    async ({ systemMessage }) => {
      if (systemMessage.content === "base first") {
        firstSnapshot = later.promise.then(() => promptContributionsFor([systemMessage], owner))
        return
      }
      secondEntered.resolve()
      await releaseSecond.promise
      expect(promptContributionsFor([systemMessage], owner)).toEqual(
        parts(["cmb:base", "base"], ["cmb:retry", " second"])
      )
    }
  )
  await secondEntered.promise
  later.resolve()
  expect(await firstSnapshot).toBeUndefined()
  releaseSecond.resolve()
  await running
})

it("keeps synchronous native handler results synchronous while closing its provenance branch", async () => {
  const owner = authority().authority
  const message = new SystemMessage("base")
  const native = observePromptSourceMiddleware(
    createMiddleware({
      name: "synchronous",
      wrapModelCall: (request, handler) => {
        const value = handler(request)
        expect(value).toBeInstanceOf(AIMessage)
        return value
      }
    })
  )
  const root = source(owner, parts(["cmb:base", "base"]))
  await root.wrapModelCall!({ systemMessage: message } as never, (request) => {
    const value = native.wrapModelCall!(request as never, () => {
      expect(promptContributionsFor([message], owner)).toEqual(parts(["cmb:base", "base"]))
      return new AIMessage("sync")
    })
    expect(value).toBeInstanceOf(AIMessage)
    return value as AIMessage
  })
})

it("preserves middleware identity fields, beforeAgent and its method receiver", async () => {
  const owner = authority().authority
  let calls = 0
  const beforeAgent = () => undefined
  const native = {
    name: "receiver",
    beforeAgent,
    wrapModelCall: function (...args: Parameters<WrapModelCallHook>) {
      expect(this).toBe(native)
      calls++
      return args[1](args[0])
    }
  }
  const observed = observePromptSourceMiddleware(native, "cmb:pass")
  expect(observed.name).toBe(native.name)
  expect(observed.beforeAgent).toBe(beforeAgent)
  await run(
    [source(owner, parts(["cmb:base", "base"])), observed],
    new SystemMessage("base"),
    ({ systemMessage }) =>
      expect(promptContributionsFor([systemMessage], owner)).toEqual(parts(["cmb:base", "base"]))
  )
  expect(calls).toBe(1)
  expect(observePromptSourceMiddleware({ name: "withoutHook" })).toEqual({ name: "withoutHook" })
})
