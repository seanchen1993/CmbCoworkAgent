import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { ModCommandQueue } from "../command-queue"
import { scheduleFunctionCommand } from "./command-scheduler"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import type { ModCommandJob } from "../../../shared/mods/types"
import type { FunctionPaneSnapshot, FunctionUiAction } from "../../../shared/mods/v2/ui"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(immediate = false, hooks = "") {
  const threadId = randomUUID()
  const jobs = new Map<string, ModCommandJob>()
  const queue = new ModCommandQueue(
    {
      jobs: () => [...jobs.values()],
      saveJob: (job) => {
        jobs.set(job.id, structuredClone(job))
      }
    },
    () => {}
  )
  const guest = await FunctionGuestRuntime.create(`
    let progress = "idle", calls = 0;
    __cmbFunctionMod = {register(on) {
      on("session.start", async ($,e,next) => {
        await $.command.register({name:"work",description:"Work",${immediate ? "immediate:true" : ""}});
        await $.ui.open({id:"work"});
        return next(e);
      });
      on("command.run",{command:"work"},async ($,e) => {
        calls++;
        await $.clock.sleep(60);
        return {text:JSON.stringify({calls,origin:e.origin,args:e.args})};
      });
      on("ui.render",($,e) => {
        const {Box,Text,Button}=$.ui.resolve(e);
        return Box({children:[Text({children:progress}),Button({key:"run",label:"Run",onPress:async()=>{
          progress="queued"; $.ui.invalidate("ui.render");
          const result=await $.command.run({command:"work",args:"from button"});
          progress=result.text; $.ui.invalidate("ui.render");
        }})]});
      });
      ${hooks}
    }};
  `)
  const session = new FunctionSession(
    [
      {
        name: "launcher",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      threadId,
      workspace: "/project",
      assertLive: () => undefined,
      publish: async (v) => v,
      scheduleCommand: (command, signal, run) =>
        scheduleFunctionCommand(queue, "/project", threadId, command, signal, run)
    }
  )
  cleanups.push(async () => {
    queue.close()
    releaseLocalThreadRunLease(threadId, "desktop", "model")
    await session.close()
  })
  await session.start()
  return { session, jobs, threadId, guest }
}

function click(pane: FunctionPaneSnapshot): FunctionUiAction {
  const button = pane.tree.children![1]
  if (typeof button === "string" || !button.press) throw Error("missing button")
  return {
    pane: pane.key,
    generation: pane.generation,
    intentId: randomUUID(),
    plugin: button.press.plugin,
    handle: button.press.handle,
    kind: "press"
  }
}

it("shows progress during a queued command, preserves its closure across redraws and runs once", async () => {
  const f = await fixture()
  claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "model" })
  const [pane] = await f.session.panes.snapshot()
  const intent = click(pane)
  const pending = f.session.panes.act(intent)
  await expect.poll(() => [...f.jobs.values()][0]?.state).toBe("queued")
  const [progress] = await f.session.panes.snapshot()
  expect(JSON.stringify(progress.tree)).toContain("queued")
  expect(progress.generation).not.toBe(pane.generation)
  await expect(f.session.panes.act({ ...intent, intentId: randomUUID() })).rejects.toThrow(
    "MODS_UI_STALE_ACTION"
  )
  releaseLocalThreadRunLease(f.threadId, "desktop", "model")
  await Promise.all([pending, f.session.panes.act(intent)])
  const [done] = await f.session.panes.snapshot()
  const text = JSON.stringify(done.tree)
  expect(text).toContain('\\"calls\\":1')
  expect(text).toContain('\\"kind\\":\\"plugin\\"')
  expect(text).toContain("from button")
  expect(f.jobs.size).toBe(1)
  expect(f.guest.stats).toMatchObject({ frames: 0, replies: 0 })
})

it("closing a pane cancels its queued intent before releasing the model lease", async () => {
  const f = await fixture()
  claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "model" })
  const [pane] = await f.session.panes.snapshot()
  const pending = f.session.panes.act(click(pane))
  const rejected = expect(pending).rejects.toThrow()
  await expect.poll(() => [...f.jobs.values()][0]?.state).toBe("queued")
  const [progress] = await f.session.panes.snapshot()
  await f.session.panes.act({ ...click(progress), kind: "close" })
  await rejected
  expect([...f.jobs.values()][0].state).toBe("cancelled")
  expect(await f.session.panes.snapshot()).toEqual([])
  releaseLocalThreadRunLease(f.threadId, "desktop", "model")
  expect([...f.jobs.values()][0].state).toBe("cancelled")
})

it("runs an immediate command from a callback while the model owns the thread", async () => {
  const f = await fixture(true)
  claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "model" })
  const [pane] = await f.session.panes.snapshot()
  await f.session.panes.act(click(pane))
  expect([...f.jobs.values()][0].state).toBe("succeeded")
})

it("retains the accepted callback when a press hook waits across a redraw", async () => {
  const f = await fixture(
    false,
    `
    on("ui.press",async($,e,next)=>{
      progress="dispatching"; $.ui.invalidate("ui.render");
      await $.clock.sleep(300); return next(e);
    });
  `
  )
  const [pane] = await f.session.panes.snapshot()
  const pending = f.session.panes.act(click(pane))
  await expect
    .poll(async () => JSON.stringify(await f.session.panes.snapshot()))
    .toContain("dispatching")
  await pending
  expect([...f.jobs.values()][0].state).toBe("succeeded")
})

it("allows a plugin to close its own pane without aborting its successful callback", async () => {
  const f = await fixture(
    false,
    `
    on("ui.press",async($,e,next)=>{
      const result=await next(e); await $.ui.close({id:"work"}); return result;
    });
  `
  )
  const [pane] = await f.session.panes.snapshot()
  await f.session.panes.act(click(pane))
  expect(await f.session.panes.snapshot()).toEqual([])
  expect([...f.jobs.values()][0].state).toBe("succeeded")
})

it("revoking a session cancels its queued command without replay", async () => {
  const f = await fixture()
  claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "model" })
  const [pane] = await f.session.panes.snapshot()
  const pending = f.session.panes.act(click(pane))
  const rejected = expect(pending).rejects.toThrow()
  await expect.poll(() => [...f.jobs.values()][0]?.state).toBe("queued")
  await f.session.close()
  await rejected
  expect([...f.jobs.values()][0].state).toBe("cancelled")
})
