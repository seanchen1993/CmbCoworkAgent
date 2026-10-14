import { expect, it, vi } from "vitest"
import { FunctionSessionActivity } from "./session-activity"
import {
  FunctionUiConstructorActivity,
  type FunctionUiConstructorBranch,
  type FunctionUiConstructorExecution,
  type FunctionUiConstructorLimits,
  type FunctionUiConstructorProof,
  type FunctionUiConstructorScope
} from "./ui-constructor-activity"

function fixture(limits: Partial<FunctionUiConstructorLimits> = {}) {
  const idle = vi.fn()
  const activity = new FunctionSessionActivity(idle)
  const ledger = new FunctionUiConstructorActivity(limits)
  const actor = Object.freeze({ definition: "actual P" })
  let generation = 1
  const proof = () => {
    const current = generation
    const receipt = Object.freeze({ actualGeneration: current })
    const controller = new AbortController()
    const owner: FunctionUiConstructorProof = {
      actor,
      receipt,
      signal: controller.signal,
      assertCurrent() {
        if (generation !== current) throw Error("actual old Q drawing")
      },
      retain: () => activity.retain()
    }
    return { owner, controller }
  }
  return {
    ledger,
    activity,
    actor,
    proof,
    idle,
    replaceDrawing() {
      generation++
    }
  }
}

it("does not retain static definitions and releases an ordinary actual call once", async () => {
  const f = fixture()
  expect(f.activity.size).toBe(0)
  expect(f.ledger.stats.scopes).toBe(0)
  const { owner } = f.proof()
  const scope = f.ledger.begin(owner)
  expect(f.activity.size).toBe(1)
  f.ledger.assertCurrent(scope, owner)
  f.ledger.finishCall(scope)
  f.ledger.finishCall(scope)
  expect(f.activity.size).toBe(0)
  expect(f.ledger.stats).toMatchObject({ scopes: 0, roots: 0, branches: 0, reactions: 0 })
  expect(() => f.ledger.assertCurrent(scope)).toThrow("MODS_UI_CONSTRUCTOR_SCOPE")
  await Promise.resolve()
  expect(f.idle).toHaveBeenCalledOnce()
})

it("keeps a continuous actual activity token across host reply, reaction and its child SDK", () => {
  const f = fixture()
  const scope = f.ledger.begin(f.proof().owner)
  const read = f.ledger.admitBranch(scope)
  const host = f.ledger.holdHost(read)
  const reply = f.ledger.holdReplyJob(read)
  const reaction = f.ledger.registerReaction(read)
  f.ledger.finishCall(scope)
  f.ledger.finishWork(host)
  f.ledger.settleBranch(read)
  expect(f.activity.size).toBe(1)
  expect(f.activity.pauseIfIdle()).toBe(false)
  let write!: FunctionUiConstructorBranch
  f.ledger.runReplyJob(reply, () => {
    f.ledger.runReaction(reaction, (execution) => {
      write = f.ledger.admitBranch(scope, execution)
      expect(f.activity.size).toBe(1)
      expect(f.activity.pauseIfIdle()).toBe(false)
    })
  })
  const writing = f.ledger.holdHost(write)
  f.ledger.settleReaction(reaction)
  f.ledger.finishWork(reply)
  expect(f.activity.size).toBe(1)
  f.ledger.settleBranch(write)
  expect(f.activity.size).toBe(1)
  f.ledger.finishWork(writing)
  expect(f.activity.size).toBe(0)
  expect(f.activity.pauseIfIdle()).toBe(true)
})

it("tracks an adopted real Promise after the synchronous reaction has returned", async () => {
  const f = fixture()
  const scope = f.ledger.begin(f.proof().owner)
  const branch = f.ledger.admitBranch(scope)
  const reaction = f.ledger.registerReaction(branch)
  const adopted = Promise.withResolvers<void>()
  f.ledger.finishCall(scope)
  f.ledger.settleBranch(branch)
  const actual = f.ledger.runReaction(reaction, () => adopted.promise)
  expect(f.activity.size).toBe(1)
  expect(f.activity.pauseIfIdle()).toBe(false)
  const settling = actual.finally(() => f.ledger.settleReaction(reaction))
  adopted.resolve()
  await settling
  expect(f.activity.size).toBe(0)
})

it("can register the next reaction from the actual reply job after SDK branch settlement", () => {
  const f = fixture()
  const scope = f.ledger.begin(f.proof().owner)
  const branch = f.ledger.admitBranch(scope)
  const reply = f.ledger.holdReplyJob(branch)
  f.ledger.finishCall(scope)
  f.ledger.settleBranch(branch)
  const reaction = f.ledger.runReplyJob(reply, (execution) =>
    f.ledger.registerReaction(branch, execution)
  )
  f.ledger.finishWork(reply)
  expect(f.activity.size).toBe(1)
  f.ledger.runReaction(reaction, () => "actual continuation")
  f.ledger.settleReaction(reaction)
  expect(f.activity.size).toBe(0)
})

it("does not allow a stored execution proof to admit SDK calls after its handler returns", () => {
  const f = fixture()
  const scope = f.ledger.begin(f.proof().owner)
  const branch = f.ledger.admitBranch(scope)
  const reaction = f.ledger.registerReaction(branch)
  f.ledger.finishCall(scope)
  let saved!: FunctionUiConstructorExecution
  f.ledger.runReaction(reaction, (execution) => {
    saved = execution
  })
  expect(() => f.ledger.admitBranch(scope, saved)).toThrow("MODS_UI_CONSTRUCTOR_SCOPE")
  expect(() => f.ledger.admitBranch(scope)).toThrow("MODS_UI_CONSTRUCTOR_SCOPE")
  expect(() => f.ledger.runReaction(reaction, () => "replay")).toThrow("MODS_UI_CONSTRUCTOR_SCOPE")
  f.ledger.settleBranch(branch)
  f.ledger.settleReaction(reaction)
  expect(f.activity.size).toBe(0)
})

it("every call fixes a new Q receipt and an old captured branch cannot borrow the latest", () => {
  const f = fixture()
  const first = f.proof().owner
  const a = f.ledger.begin(first)
  const branch = f.ledger.admitBranch(a)
  const reaction = f.ledger.registerReaction(branch)
  f.ledger.finishCall(a)
  f.replaceDrawing()
  const second = f.proof().owner
  const b = f.ledger.begin(second)
  f.ledger.assertCurrent(b, second)
  expect(() => f.ledger.assertCurrent(a, second)).toThrow("MODS_UI_CONSTRUCTOR_SCOPE")
  expect(() => f.ledger.assertCurrent(b, { actor: {}, receipt: second.receipt })).toThrow(
    "MODS_UI_CONSTRUCTOR_SCOPE"
  )
  expect(() => f.ledger.runReaction(reaction, () => "late effect")).toThrow("actual old Q drawing")
  expect(f.ledger.signal(a).aborted).toBe(true)
  f.ledger.settleReaction(reaction)
  f.ledger.settleBranch(branch)
  expect(f.activity.size).toBe(1)
  f.ledger.finishCall(b)
  expect(f.activity.size).toBe(0)
})

it("seals effects on revocation but waits for an ignore-abort host actual finally", async () => {
  const f = fixture()
  const { owner, controller } = f.proof()
  const scope = f.ledger.begin(owner)
  const branch = f.ledger.admitBranch(scope)
  const host = f.ledger.holdHost(branch)
  const reply = f.ledger.holdReplyJob(branch)
  const reaction = f.ledger.registerReaction(branch)
  const cleanup = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const actual = (async () => {
    entered.resolve()
    try {
      await cleanup.promise
    } finally {
      f.ledger.finishWork(host)
    }
  })()
  await entered.promise
  f.ledger.finishCall(scope)
  controller.abort(Error("actual revoke"))
  const effect = vi.fn()
  expect(() => f.ledger.runReaction(reaction, () => effect())).toThrow("actual revoke")
  expect(() => f.ledger.holdHost(branch)).toThrow("actual revoke")
  expect(effect).not.toHaveBeenCalled()
  f.ledger.settleReaction(reaction)
  f.ledger.finishWork(reply)
  f.ledger.settleBranch(branch)
  expect(f.activity.size).toBe(1)
  expect(f.activity.pauseIfIdle()).toBe(false)
  cleanup.resolve()
  await actual
  expect(f.activity.size).toBe(0)
})

it("normal synchronous completion does not cancel an admitted SDK branch", () => {
  const f = fixture()
  const scope = f.ledger.begin(f.proof().owner)
  const branch = f.ledger.admitBranch(scope)
  f.ledger.finishCall(scope)
  // The registry owns the synchronous cut. This lifecycle proof has no fresh/captured CPU clock.
  expect(f.ledger.signal(scope).aborted).toBe(false)
  f.ledger.assertCurrent(scope)
  expect(f.activity.size).toBe(1)
  f.ledger.settleBranch(branch)
  expect(f.activity.size).toBe(0)
})

it("rejects forged tokens and another ledger's minted scope without touching its activity", () => {
  const f = fixture()
  const scope = f.ledger.begin(f.proof().owner)
  const other = new FunctionUiConstructorActivity()
  expect(() => f.ledger.assertCurrent({ ...scope } as FunctionUiConstructorScope)).toThrow(
    "MODS_UI_CONSTRUCTOR_SCOPE"
  )
  expect(() => other.assertCurrent(scope)).toThrow("MODS_UI_CONSTRUCTOR_SCOPE")
  expect(f.activity.size).toBe(1)
  f.ledger.finishCall(scope)
})

it("limits shared roots, branches and reactions without corrupting successful reservations", () => {
  const f = fixture({ roots: 1, branches: 1, reactions: 1 })
  const scope = f.ledger.begin(f.proof().owner)
  expect(() => f.ledger.begin(f.proof().owner)).toThrow("MODS_UI_CONSTRUCTOR_LIMIT")
  const branch = f.ledger.admitBranch(scope)
  expect(() => f.ledger.admitBranch(scope)).toThrow("MODS_UI_CONSTRUCTOR_LIMIT")
  const reaction = f.ledger.registerReaction(branch)
  expect(() => f.ledger.registerReaction(branch)).toThrow("MODS_UI_CONSTRUCTOR_LIMIT")
  const host = f.ledger.holdHost(branch)
  expect(() => f.ledger.holdHost(branch)).toThrow("MODS_UI_CONSTRUCTOR_SCOPE")
  f.ledger.finishCall(scope)
  f.ledger.settleBranch(branch)
  f.ledger.settleReaction(reaction)
  f.ledger.settleReaction(reaction)
  f.ledger.finishWork(host)
  f.ledger.finishWork(host)
  expect(f.ledger.stats).toMatchObject({ scopes: 0, roots: 0, branches: 0, reactions: 0 })
})

it("running callbacks cannot release their own occupancy before the actual returned boundary", () => {
  const f = fixture()
  const scope = f.ledger.begin(f.proof().owner)
  const branch = f.ledger.admitBranch(scope)
  const reply = f.ledger.holdReplyJob(branch)
  const reaction = f.ledger.registerReaction(branch)
  f.ledger.finishCall(scope)
  f.ledger.settleBranch(branch)
  f.ledger.runReplyJob(reply, () => {
    expect(() => f.ledger.finishWork(reply)).toThrow("MODS_UI_CONSTRUCTOR_SCOPE")
    f.ledger.runReaction(reaction, () => {
      expect(() => f.ledger.settleReaction(reaction)).toThrow("MODS_UI_CONSTRUCTOR_SCOPE")
      expect(f.activity.size).toBe(1)
    })
  })
  f.ledger.finishWork(reply)
  f.ledger.settleReaction(reaction)
  expect(f.activity.size).toBe(0)
})

it("close fences new effects and admission while genuine cleanup can drain existing receipts", () => {
  const f = fixture()
  const scope = f.ledger.begin(f.proof().owner)
  const branch = f.ledger.admitBranch(scope)
  const host = f.ledger.holdHost(branch)
  f.ledger.close(Error("real Session disposed"))
  f.ledger.close()
  expect(() => f.ledger.begin(f.proof().owner)).toThrow("MODS_UI_CONSTRUCTOR_SCOPE")
  expect(() => f.ledger.assertCurrent(scope)).toThrow("real Session disposed")
  expect(f.activity.size).toBe(1)
  f.ledger.finishCall(scope)
  f.ledger.settleBranch(branch)
  expect(f.activity.size).toBe(1)
  f.ledger.finishWork(host)
  expect(f.activity.size).toBe(0)
})

it("rechecks the actual owner after retain and returns a failed admission's unused token", () => {
  const f = fixture()
  const owner = f.proof().owner
  const retained = owner.retain
  owner.retain = () => {
    const release = retained()
    f.replaceDrawing()
    return release
  }
  expect(() => f.ledger.begin(owner)).toThrow("actual old Q drawing")
  expect(f.activity.size).toBe(0)
  expect(f.ledger.stats.scopes).toBe(0)
})

it("reserves the root limit before a reentrant host retain callback", () => {
  const f = fixture({ roots: 1 })
  const owner = f.proof().owner
  const retain = owner.retain
  owner.retain = () => {
    expect(() => f.ledger.begin(f.proof().owner)).toThrow("MODS_UI_CONSTRUCTOR_LIMIT")
    return retain()
  }
  const scope = f.ledger.begin(owner)
  expect(f.ledger.stats.roots).toBe(1)
  f.ledger.finishCall(scope)
  expect(f.activity.size).toBe(0)
})

it("keeps an uncertain failed-admission release occupied instead of retrying or hiding it", () => {
  let current = true
  const release = vi.fn(() => {
    throw Error("rollback release uncertain")
  })
  const ledger = new FunctionUiConstructorActivity({ roots: 1 })
  expect(() =>
    ledger.begin({
      actor: {},
      receipt: {},
      signal: new AbortController().signal,
      assertCurrent() {
        if (!current) throw Error("actual expired during retain")
      },
      retain() {
        current = false
        return release
      }
    })
  ).toThrow("rollback release uncertain")
  expect(release).toHaveBeenCalledOnce()
  expect(ledger.stats).toMatchObject({ scopes: 1, roots: 0, failedReleases: 1 })
  expect(() =>
    ledger.begin({
      actor: {},
      receipt: {},
      signal: new AbortController().signal,
      assertCurrent() {
        return undefined
      },
      retain: () => () => undefined
    })
  ).toThrow("MODS_UI_CONSTRUCTOR_LIMIT")
  ledger.close()
  expect(release).toHaveBeenCalledOnce()
})

it("does not retry an uncertain activity release or announce idle cleanup success", () => {
  const release = vi.fn(() => {
    throw Error("host release uncertain")
  })
  const ledger = new FunctionUiConstructorActivity({ roots: 1 })
  const scope = ledger.begin({
    actor: {},
    receipt: {},
    signal: new AbortController().signal,
    assertCurrent() {
      return undefined
    },
    retain: () => release
  })
  expect(() => ledger.finishCall(scope)).toThrow("host release uncertain")
  ledger.finishCall(scope)
  ledger.close()
  expect(release).toHaveBeenCalledOnce()
  expect(ledger.stats).toMatchObject({ scopes: 1, roots: 0, failedReleases: 1 })
  expect(() => ledger.assertCurrent(scope)).toThrow("MODS_UI_CONSTRUCTOR_SCOPE")
  expect(() =>
    ledger.begin({
      actor: {},
      receipt: {},
      signal: new AbortController().signal,
      assertCurrent() {
        return undefined
      },
      retain: () => () => undefined
    })
  ).toThrow("MODS_UI_CONSTRUCTOR_SCOPE")
})

it("the drain receipt waits for actual host finally and guest reply/reaction settlement", async () => {
  const f = fixture()
  const scope = f.ledger.begin(f.proof().owner)
  const branch = f.ledger.admitBranch(scope)
  const host = f.ledger.holdHost(branch)
  const reply = f.ledger.holdReplyJob(branch)
  const reaction = f.ledger.registerReaction(branch)
  const drained = f.ledger.whenDrained(scope)
  expect(f.ledger.whenDrained(scope)).toBe(drained)
  const done = vi.fn()
  void drained.then(done)
  f.ledger.finishCall(scope)
  f.ledger.settleBranch(branch)
  f.ledger.finishWork(host)
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  f.ledger.runReplyJob(reply, () => f.ledger.runReaction(reaction, () => "real continuation"))
  f.ledger.finishWork(reply)
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  f.ledger.settleReaction(reaction)
  await drained
  expect(done).toHaveBeenCalledOnce()
  expect(f.activity.size).toBe(0)
})

it("a truly canceled scope without outstanding activity resolves only after root release", async () => {
  const f = fixture()
  const { owner, controller } = f.proof()
  const scope = f.ledger.begin(owner)
  const drained = f.ledger.whenDrained(scope)
  const done = vi.fn()
  void drained.then(done)
  controller.abort(Error("actual cancel"))
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  expect(f.activity.size).toBe(1)
  f.ledger.finishCall(scope)
  await drained
  await f.ledger.whenDrained(scope)
  expect(done).toHaveBeenCalledOnce()
  expect(f.activity.size).toBe(0)
})

it("a drain requested after normal cleanup is already resolved without retaining anything", async () => {
  const f = fixture()
  const scope = f.ledger.begin(f.proof().owner)
  f.ledger.finishCall(scope)
  await f.ledger.whenDrained(scope)
  expect(f.activity.size).toBe(0)
  expect(f.ledger.stats.scopes).toBe(0)
})

it("an uncertain release rejects both existing and late drain receipts without retry", async () => {
  const release = vi.fn(() => {
    throw Error("actual cleanup failed")
  })
  const ledger = new FunctionUiConstructorActivity()
  const scope = ledger.begin({
    actor: {},
    receipt: {},
    signal: new AbortController().signal,
    assertCurrent() {
      return undefined
    },
    retain: () => release
  })
  const drained = ledger.whenDrained(scope)
  expect(() => ledger.finishCall(scope)).toThrow("actual cleanup failed")
  await expect(drained).rejects.toThrow("actual cleanup failed")
  await expect(ledger.whenDrained(scope)).rejects.toThrow("actual cleanup failed")
  ledger.finishCall(scope)
  ledger.close()
  expect(release).toHaveBeenCalledOnce()
  expect(ledger.stats.scopes).toBe(1)
})

it("zero native credit is valid but cannot mint roots until the exact next host ACK", () => {
  const identity = Object.freeze({})
  const ledger = new FunctionUiConstructorActivity(
    { roots: 0, branches: 0, reactions: 0 },
    { identity, revision: 0 }
  )
  const retain = vi.fn(() => () => undefined)
  const proof = {
    actor: {},
    receipt: {},
    signal: new AbortController().signal,
    assertCurrent: () => undefined,
    retain
  }
  expect(() => ledger.begin(proof)).toThrow("MODS_UI_CONSTRUCTOR_LIMIT")
  expect(retain).not.toHaveBeenCalled()
  expect(() => ledger.increaseCredit({}, 1, { roots: 1, branches: 1, reactions: 1 })).toThrow(
    "MODS_UI_CONSTRUCTOR_CREDIT"
  )
  ledger.increaseCredit(identity, 1, { roots: 1, branches: 1, reactions: 1 })
  ledger.increaseCredit(identity, 1, { roots: 1, branches: 1, reactions: 1 })
  expect(() => ledger.increaseCredit(identity, 0, { roots: 1, branches: 1, reactions: 1 })).toThrow(
    "MODS_UI_CONSTRUCTOR_CREDIT"
  )
  const scope = ledger.begin(proof)
  ledger.finishCall(scope)
  expect(retain).toHaveBeenCalledOnce()
})

it("announces a closed returned root with only queued reactions once without releasing it", async () => {
  const f = fixture()
  const { owner, controller } = f.proof()
  const quiescent = vi.fn()
  owner.quiescent = quiescent
  const scope = f.ledger.begin(owner)
  const branch = f.ledger.admitBranch(scope)
  const reaction = f.ledger.registerReaction(branch)
  f.ledger.settleBranch(branch)
  const done = vi.fn()
  void f.ledger.whenDrained(scope).then(done)
  controller.abort(Error("actual drawing closed"))
  expect(quiescent).not.toHaveBeenCalled()
  f.ledger.finishCall(scope)
  expect(quiescent).toHaveBeenCalledOnce()
  expect(f.activity.size).toBe(1)
  expect(f.ledger.stats).toMatchObject({ scopes: 1, roots: 0, branches: 1, reactions: 1 })
  f.ledger.finishCall(scope)
  f.ledger.revoke(scope)
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  expect(quiescent).toHaveBeenCalledOnce()
  f.ledger.settleReaction(reaction)
  await f.ledger.whenDrained(scope)
  expect(done).toHaveBeenCalledOnce()
  expect(f.activity.size).toBe(0)
})

it("counts reserved host and reply receipts before any actual host call can begin", () => {
  const f = fixture()
  const { owner, controller } = f.proof()
  const quiescent = vi.fn()
  owner.quiescent = quiescent
  const scope = f.ledger.begin(owner)
  const waiting = f.ledger.admitBranch(scope)
  const reaction = f.ledger.registerReaction(waiting)
  f.ledger.settleBranch(waiting)
  const sdk = f.ledger.admitBranch(scope)
  const host = f.ledger.holdHost(sdk)
  const reply = f.ledger.holdReplyJob(sdk)
  f.ledger.finishCall(scope)
  controller.abort()
  expect(quiescent).not.toHaveBeenCalled()
  f.ledger.finishWork(host)
  expect(quiescent).not.toHaveBeenCalled()
  f.ledger.finishWork(reply)
  expect(quiescent).not.toHaveBeenCalled()
  f.ledger.settleBranch(sdk)
  expect(quiescent).toHaveBeenCalledOnce()
  expect(f.ledger.stats).toMatchObject({ scopes: 1, branches: 1, reactions: 1 })
  f.ledger.settleReaction(reaction)
})

it("does not confuse an internal failure with the original drawing signal's terminal proof", () => {
  const f = fixture()
  const { owner, controller } = f.proof()
  const quiescent = vi.fn()
  owner.quiescent = quiescent
  const scope = f.ledger.begin(owner)
  const branch = f.ledger.admitBranch(scope)
  const reaction = f.ledger.registerReaction(branch)
  f.ledger.settleBranch(branch)
  f.ledger.finishCall(scope)
  f.ledger.revoke(scope, Error("caught constructor error"))
  expect(f.ledger.signal(scope).aborted).toBe(true)
  expect(controller.signal.aborted).toBe(false)
  expect(quiescent).not.toHaveBeenCalled()
  controller.abort(Error("actual old drawing closed"))
  expect(quiescent).toHaveBeenCalledOnce()
  expect(() => f.ledger.runReaction(reaction, () => "late SDK")).toThrow()
  f.ledger.settleReaction(reaction)
})

it("never downgrades an entered reaction or its returned unsettled adoption", () => {
  const f = fixture()
  const { owner, controller } = f.proof()
  const quiescent = vi.fn()
  owner.quiescent = quiescent
  const scope = f.ledger.begin(owner)
  const branch = f.ledger.admitBranch(scope)
  const reaction = f.ledger.registerReaction(branch)
  f.ledger.settleBranch(branch)
  f.ledger.finishCall(scope)
  const returned = f.ledger.runReaction(reaction, () => {
    controller.abort(Error("closed during real callback"))
    expect(quiescent).not.toHaveBeenCalled()
    return new Promise<void>(() => undefined)
  })
  expect(returned).toBeInstanceOf(Promise)
  expect(quiescent).not.toHaveBeenCalled()
  expect(f.activity.size).toBe(1)
  // Actual VM disposal may discard this reaction; the quiescent observer cannot.
  f.ledger.settleReaction(reaction)
  expect(quiescent).not.toHaveBeenCalled()
  expect(f.activity.size).toBe(0)
})

it("isolates a failed native quiescent notification and never treats it as release", () => {
  const f = fixture()
  const { owner, controller } = f.proof()
  const quiescent = vi.fn(() => {
    throw Error("native port unavailable")
  })
  owner.quiescent = quiescent
  const scope = f.ledger.begin(owner)
  const branch = f.ledger.admitBranch(scope)
  const reaction = f.ledger.registerReaction(branch)
  f.ledger.settleBranch(branch)
  f.ledger.finishCall(scope)
  expect(() => controller.abort()).not.toThrow()
  expect(quiescent).toHaveBeenCalledOnce()
  expect(f.activity.size).toBe(1)
  f.ledger.close()
  expect(quiescent).toHaveBeenCalledOnce()
  f.ledger.settleReaction(reaction)
  expect(f.activity.size).toBe(0)
})

it("never downgrades a quarantined uncertain release", () => {
  const controller = new AbortController()
  const quiescent = vi.fn()
  const ledger = new FunctionUiConstructorActivity()
  const scope = ledger.begin({
    actor: {},
    receipt: {},
    signal: controller.signal,
    assertCurrent: () => undefined,
    quiescent,
    retain: () => () => {
      throw Error("uncertain actual release")
    }
  })
  expect(() => ledger.finishCall(scope)).toThrow("uncertain actual release")
  controller.abort()
  expect(quiescent).not.toHaveBeenCalled()
  expect(ledger.stats).toMatchObject({ scopes: 1, failedReleases: 1 })
})
