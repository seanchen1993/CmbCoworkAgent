import { resolve } from "node:path"
import { glob } from "tinyglobby"
import { expect, it } from "vitest"
import { configDefaults } from "vitest/config"
import { createVitest } from "vitest/node"
import { NATIVE_INTEGRATION_TESTS, VITEST_TEST_INCLUDE } from "../../vitest.config"

it("collects the unchanged suite exactly once and schedules native graphs before parallel work", async () => {
  const root = resolve(import.meta.dirname, "../..")
  const context = await createVitest("test", {
    root,
    config: resolve(root, "vitest.config.ts"),
    watch: false
  })
  try {
    const specs = await context.globTestSpecifications()
    const original = await glob(VITEST_TEST_INCLUDE, {
      cwd: root,
      absolute: true,
      ignore: configDefaults.exclude
    })
    const canonical = (file: string) => resolve(file)
    const collected = specs.map((spec) => canonical(spec.moduleId))
    expect(new Set(collected).size).toBe(collected.length)
    expect([...collected].sort()).toEqual(original.map(canonical).sort())

    const nativeFiles = new Set(NATIVE_INTEGRATION_TESTS.map((file) => resolve(root, file)))
    expect(NATIVE_INTEGRATION_TESTS).toContain(
      "src/main/agent/function-conversation-native-keeper.test.ts"
    )
    const native = context.projects.find((project) => project.name === "native-integration")
    const parallel = context.projects.find((project) => project.name === "parallel")
    expect(native?.config.sequence.groupOrder).toBe(0)
    expect(parallel?.config.sequence.groupOrder).toBe(1)
    expect(native?.config.pool).toBe("forks")
    expect(native?.config.poolOptions?.forks).toMatchObject({ singleFork: true, isolate: true })
    expect(parallel?.config.poolOptions?.forks?.singleFork).not.toBe(true)
    for (const spec of specs) {
      expect(spec.project.name).toBe(
        nativeFiles.has(canonical(spec.moduleId)) ? "native-integration" : "parallel"
      )
      expect(spec.project.config.testTimeout).toBe(5000)
      expect(spec.project.config.environment).toBe("node")
    }
    // Existing file-based commands must still select just their real project,
    // including renderer utility tests and the expensive native graph suite.
    for (const file of [
      NATIVE_INTEGRATION_TESTS[0],
      "src/renderer/src/lib/function-message-text.test.ts"
    ]) {
      const filtered = await context.globTestSpecifications([file])
      expect(filtered.map((spec) => canonical(spec.moduleId))).toEqual([resolve(root, file)])
    }
  } finally {
    await context.close()
  }
})
