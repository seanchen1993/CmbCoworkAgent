import { expect, it } from "vitest"
import { sourceSetError } from "../../src/renderer/src/components/customize/source-set-view"
it.each([
  ["PROJECT_SOURCE_SET_DESCRIPTOR_REQUIRED", "devclaw.source-set.json"],
  ["SOURCE_SET_INSTALLED_CONFLICT", "不会覆盖"],
  ["SOURCE_SET_AUTHORIZATION_CHANGED", "原生权限"],
  ["SOURCE_SET_INSTALL_UNCONFIRMED", "不会重复安装"],
  ["PROJECT_SOURCE_SET_PATH_UNSAFE", "不支持的路径"],
  ["SOURCE_SET_PROJECT_CHANGED", "重新选择"]
])("gives a concrete recovery instruction for %s", (code, instruction) => {
  expect(sourceSetError(code)).toContain(instruction)
  expect(sourceSetError(code)).not.toContain(code)
})
