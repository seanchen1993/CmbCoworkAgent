import { expect, it } from "vitest"
import { botHostStartupEnvironment } from "./host-startup-environment"
import { botShellEnvironment } from "./shell-contract"

it("native startup configuration reaches only Host; ordinary command environment removes it", () => {
  const source = {
    PATH: "/fixture/tools",
    HTTPS_PROXY: "http://proxy.invalid:8080",
    https_proxy: "",
    CMB_BOT_NATIVE_SANDBOX_DIRECTORY: "/fixture/native",
    CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256: "a".repeat(64),
    CMB_BOT_DELEGATED_CGROUP_DIRECTORY: "/fixture/delegated",
    CMB_BOT_SHELL_PIDS_MAX: "512",
    CMB_BOT_SHELL_MEMORY_MAX_BYTES: "2147483648",
    CMB_BOT_NATIVE_FORCE_READY: "true",
    MODEL_API_KEY: "secret",
    CMB_BOT_RESOURCE_JOB: "private-job"
  }
  const host = botHostStartupEnvironment(source)
  expect(host).toMatchObject({
    CMB_BOT_NATIVE_SANDBOX_DIRECTORY: source.CMB_BOT_NATIVE_SANDBOX_DIRECTORY,
    CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256: source.CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256,
    CMB_BOT_DELEGATED_CGROUP_DIRECTORY: source.CMB_BOT_DELEGATED_CGROUP_DIRECTORY,
    CMB_BOT_SHELL_PIDS_MAX: source.CMB_BOT_SHELL_PIDS_MAX,
    CMB_BOT_SHELL_MEMORY_MAX_BYTES: source.CMB_BOT_SHELL_MEMORY_MAX_BYTES
  })
  expect(host).not.toHaveProperty("CMB_BOT_NATIVE_FORCE_READY")
  expect(host).not.toHaveProperty("MODEL_API_KEY")
  expect(host).not.toHaveProperty("CMB_BOT_RESOURCE_JOB")
  expect(botShellEnvironment(host)).toEqual({
    PATH: source.PATH,
    HTTPS_PROXY: source.HTTPS_PROXY,
    https_proxy: ""
  })
  expect(source.MODEL_API_KEY).toBe("secret")
})

it("explicit empty native configuration is preserved for strict runtime validation", () => {
  const source = {
    CMB_BOT_NATIVE_SANDBOX_DIRECTORY: "",
    CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256: "configured-digest"
  }
  expect(botHostStartupEnvironment(source)).toEqual(source)
  expect(botShellEnvironment(botHostStartupEnvironment(source))).toEqual({})
})
