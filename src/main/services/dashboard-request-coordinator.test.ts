import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { describe, expect, it } from "vitest"
import {
  DashboardRequestCancelledError,
  DashboardRequestCoordinator,
  getDashboardRequestSignal
} from "./dashboard-request-coordinator"

class FakeWebContents extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
}

function asWebContents(value: FakeWebContents): WebContents {
  return value as unknown as WebContents
}

function cancellableOperation(): {
  operation: () => Promise<string>
  resolve: (value: string) => void
} {
  let resolveOperation: (value: string) => void = () => undefined
  return {
    operation: () => {
      const signal = getDashboardRequestSignal()
      if (!signal) throw new Error("missing dashboard request signal")
      return new Promise<string>((resolve, reject) => {
        resolveOperation = resolve
        signal.addEventListener("abort", () => reject(new DashboardRequestCancelledError()), {
          once: true
        })
      })
    },
    resolve: (value) => resolveOperation(value)
  }
}

describe("DashboardRequestCoordinator", () => {
  it("keeps only the latest A -> B -> C request in a webContents family", async () => {
    const coordinator = new DashboardRequestCoordinator()
    const sender = asWebContents(new FakeWebContents(11))
    const a = cancellableOperation()
    const b = cancellableOperation()
    const c = cancellableOperation()

    const aResult = coordinator.run(sender, "dashboard:projectMode", a.operation).catch((e) => e)
    const bResult = coordinator.run(sender, "dashboard:projectMode", b.operation).catch((e) => e)
    const cResult = coordinator.run(sender, "dashboard:projectMode", c.operation)
    c.resolve("C")

    await expect(aResult).resolves.toBeInstanceOf(DashboardRequestCancelledError)
    await expect(bResult).resolves.toBeInstanceOf(DashboardRequestCancelledError)
    await expect(cResult).resolves.toBe("C")
  })

  it("isolates equal families from different webContents", async () => {
    const coordinator = new DashboardRequestCoordinator()
    const first = cancellableOperation()
    const second = cancellableOperation()
    const firstResult = coordinator.run(
      asWebContents(new FakeWebContents(1)),
      "dashboard:overview",
      first.operation
    )
    const secondResult = coordinator.run(
      asWebContents(new FakeWebContents(2)),
      "dashboard:overview",
      second.operation
    )

    first.resolve("first")
    second.resolve("second")
    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual(["first", "second"])
  })

  it("allows independent request families in the same webContents", async () => {
    const coordinator = new DashboardRequestCoordinator()
    const sender = asWebContents(new FakeWebContents(3))
    const dashboardMarket = cancellableOperation()
    const projectMarket = cancellableOperation()
    const dashboardResult = coordinator.run(
      sender,
      "dashboard:userProfiles:dashboard-market",
      dashboardMarket.operation
    )
    const projectResult = coordinator.run(
      sender,
      "dashboard:userProfiles:project-mode-market",
      projectMarket.operation
    )

    dashboardMarket.resolve("dashboard")
    projectMarket.resolve("project")
    await expect(Promise.all([dashboardResult, projectResult])).resolves.toEqual([
      "dashboard",
      "project"
    ])
  })

  it("cancels child families by prefix on unload and on webContents destruction", async () => {
    const coordinator = new DashboardRequestCoordinator()
    const fakeSender = new FakeWebContents(7)
    const sender = asWebContents(fakeSender)
    const activePage = cancellableOperation()
    const archivedPage = cancellableOperation()
    const activeResult = coordinator
      .run(sender, "dashboard:projectModeProjects:active", activePage.operation)
      .catch((e) => e)
    const archivedResult = coordinator
      .run(sender, "dashboard:projectModeProjects:archived", archivedPage.operation)
      .catch((e) => e)

    expect(coordinator.cancel(7, [])).toBe(0)
    expect(coordinator.cancel(7, ["dashboard:projectModeProjects"])).toBe(2)
    await expect(activeResult).resolves.toBeInstanceOf(DashboardRequestCancelledError)
    await expect(archivedResult).resolves.toBeInstanceOf(DashboardRequestCancelledError)

    const destroyed = cancellableOperation()
    const destroyedResult = coordinator
      .run(sender, "dashboard:overview", destroyed.operation)
      .catch((e) => e)
    fakeSender.emit("destroyed")
    await expect(destroyedResult).resolves.toBeInstanceOf(DashboardRequestCancelledError)
  })

  it("does not let a late cancelled request remove a newer request map", async () => {
    const coordinator = new DashboardRequestCoordinator()
    const sender = asWebContents(new FakeWebContents(21))
    let finishOld: () => void = () => undefined
    const oldResult = coordinator
      .run(
        sender,
        "dashboard:skillEvalSummary:list",
        () =>
          new Promise<void>((resolve) => {
            finishOld = resolve
          })
      )
      .catch((error) => error)

    expect(coordinator.cancel(21, ["dashboard:skillEvalSummary"])).toBe(1)
    const current = cancellableOperation()
    const currentResult = coordinator
      .run(sender, "dashboard:overview", current.operation)
      .catch((error) => error)
    finishOld()
    await expect(oldResult).resolves.toBeInstanceOf(DashboardRequestCancelledError)

    expect(coordinator.cancel(21, ["dashboard:overview"])).toBe(1)
    await expect(currentResult).resolves.toBeInstanceOf(DashboardRequestCancelledError)
  })
})
