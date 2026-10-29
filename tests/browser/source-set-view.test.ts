import { expect, it } from "vitest"
import {
  runSourceSetWhenIdle,
  sourceSetError,
  sourceSetFailureCode
} from "../../src/renderer/src/components/customize/source-set-view"
it.each([
  ["PROJECT_SOURCE_SET_DESCRIPTOR_REQUIRED", "devclaw.source-set.json"],
  ["SOURCE_SET_INSTALLED_CONFLICT", "不会覆盖"],
  ["SOURCE_SET_AUTHORIZATION_CHANGED", "原生权限"],
  ["SOURCE_SET_INSTALL_UNCONFIRMED", "不会重复安装"],
  ["PROJECT_SOURCE_SET_PATH_UNSAFE", "不支持的路径"],
  ["SOURCE_SET_PROJECT_CHANGED", "重新选择"],
  ["SOURCE_SET_BUSY", "尚未开始"]
])("gives a concrete recovery instruction for %s", (code, instruction) => {
  expect(sourceSetError(code)).toContain(instruction)
  expect(sourceSetError(code)).not.toContain(code)
})

it("retries only exact native pre-admission busy within one bounded intent", async () => {
  let calls = 0
  const waits: number[] = []
  const result = await runSourceSetWhenIdle(
    async () => {
      calls++
      if (calls < 3) throw Error("SOURCE_SET_BUSY")
      return "started once"
    },
    () => {},
    async (ms) => {
      waits.push(ms)
    }
  )
  expect(result).toBe("started once")
  expect(calls).toBe(3)
  expect(waits).toEqual([75, 125])
  calls = 0
  await expect(
    runSourceSetWhenIdle(
      async () => {
        calls++
        throw Error("SOURCE_SET_BUSY")
      },
      () => {},
      async () => {}
    )
  ).rejects.toThrow("SOURCE_SET_BUSY")
  expect(calls).toBe(6)
})

it("never retries unknown outcomes, generic failures or scope changes during the idle wait", async () => {
  for (const code of [
    "SOURCE_SET_SCOPE_CHANGED",
    "SOURCE_SET_INSTALL_UNCONFIRMED",
    "SOURCE_SET_BUSY_OR_SCOPE_CHANGED",
    "unexpected SOURCE_SET_BUSY"
  ]) {
    let calls = 0
    await expect(
      runSourceSetWhenIdle(
        async () => {
          calls++
          throw Error(code)
        },
        () => {},
        async () => {}
      )
    ).rejects.toThrow(code)
    expect(calls).toBe(1)
  }
  let current = true,
    calls = 0
  await expect(
    runSourceSetWhenIdle(
      async () => {
        calls++
        throw Error("SOURCE_SET_BUSY")
      },
      () => {
        if (!current) throw Error("DEVELOPMENT_SCOPE_CHANGED")
      },
      async () => {
        current = false
      }
    )
  ).rejects.toThrow("DEVELOPMENT_SCOPE_CHANGED")
  expect(calls).toBe(1)
  expect(
    sourceSetFailureCode(
      Error(
        "Error invoking remote method 'mods:development:install-source-set-dependency': Error: SOURCE_SET_BUSY"
      )
    )
  ).toBe("SOURCE_SET_BUSY")
  expect(sourceSetFailureCode(Error("unknown result SOURCE_SET_BUSY"))).toBe(
    "SOURCE_SET_PREPARATION_FAILED"
  )
})
