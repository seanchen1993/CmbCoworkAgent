import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ModObject } from "../../../shared/mods/types"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import { compileFunctionPlugin } from "./loader"
import * as loader from "./loader"
import { FunctionUserConfigValues } from "./user-config-values"
import { filterModData } from "../publication"
import { DEFAULT_COMPLETION_POLICY } from "../../../shared/mods/v2/completion-policy"
import { testSecretProtector } from "../../../../tests/support/mods-secret-protector"
import { writeFileSync } from "node:fs"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(
  required = false,
  count = 1,
  mixed = false,
  startup = "",
  hooks = "",
  sensitive = false
) {
  const root = await mkdtemp(join(tmpdir(), "mods-config-options-")),
    path = join(root, "plugin")
  await mkdir(join(path, "hooks"), { recursive: true })
  await writeFile(
    join(path, "plugin.json"),
    JSON.stringify({
      name: "config-options",
      userConfig: {
        tone: {
          type: "string",
          title: "Tone",
          description: "Voice",
          required,
          ...(required ? {} : { default: "warm" })
        },
        flag: { type: "boolean", title: "Flag", description: "Flag", default: false },
        budget: { type: "number", title: "Budget", description: "Budget", default: 0 },
        ...(sensitive
          ? {
              token: {
                type: "string",
                sensitive: true,
                required: true,
                title: "Token",
                description: "Help"
              },
              hiddenFile: {
                type: "file",
                sensitive: true,
                title: "Hidden path",
                description: "Help"
              }
            }
          : {}),
        ...(mixed
          ? {
              path: { type: "file", title: "Path", description: "Optional file" },
              directory: {
                type: "directory",
                title: "Directory",
                description: "Optional directory"
              },
              list: {
                type: "string",
                multiple: true,
                title: "List",
                description: "List",
                default: ["a,b"]
              },
              scalarList: {
                type: "string",
                multiple: true,
                title: "Legacy",
                description: "Legacy",
                default: "a,b\nc"
              }
            }
          : {})
      }
    })
  )
  await writeFile(join(path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  await writeFile(
    join(path, "hooks/register.ts"),
    `export function register(on,options){
    on("session.start",async($,e,next)=>{await $.command.register({name:"options-probe",description:JSON.stringify(options)});${startup};return next(e)})
    ${hooks}
  }`
  )
  const sources = [{ id: "p", name: "config-options", path, enabled: true }]
  if (count > 1) {
    const second = join(root, "second")
    await mkdir(join(second, "hooks"), { recursive: true })
    await writeFile(join(second, "plugin.json"), '{"name":"second-options"}')
    await writeFile(join(second, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
    await writeFile(join(second, "hooks/register.ts"), "export function register() {}")
    sources.push({ id: "q", name: "second-options", path: second, enabled: true })
  }
  const protector = testSecretProtector()
  const store = new ModControlStore(join(root, "control.sqlite")),
    values = new FunctionUserConfigValues(store, sensitive ? protector : undefined)
  const guests: FunctionGuestRuntime[] = []
  let busy = false
  const configChanged = vi.fn()
  const publish = vi.fn(
    async (_workspace: string, value: import("../../../shared/mods/types").ModJson) =>
      filterModData(value, true)
  )
  const load = vi.fn(async (code: string, options: ModObject) => {
    const guest = await FunctionGuestRuntime.create(code, options)
    guests.push(guest)
    return guest
  })
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => sources,
      enabled: () => true,
      publish,
      changed: () => {},
      configChanged,
      ...(sensitive ? { secretProtector: protector } : {}),
      configurationBusy: () => busy
    },
    () => {
      const owned: FunctionGuestRuntime[] = []
      return {
        load: async (...args) => {
          const guest = await load(...args)
          owned.push(guest)
          return guest
        },
        stop: () => {
          for (const guest of owned) guest.dispose()
        }
      }
    }
  )
  cleanup.push(async () => {
    manager.close()
    store.close()
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-config-options-")
    )
      throw Error("Unexpected cleanup target")
    await rm(root, { recursive: true, force: true })
  })
  const compiled = await compileFunctionPlugin(path)
  store.grant(root, "function:config-options", compiled.digest, true)
  for (const source of sources.slice(1)) {
    const other = await compileFunctionPlugin(source.path)
    store.grant(root, `function:${other.name}`, other.digest, true)
  }
  return {
    root,
    path,
    store,
    values,
    load,
    manager,
    compiled,
    configChanged,
    publish,
    protector,
    busy: (value: boolean) => {
      busy = value
    }
  }
}

it("real confidential parameters never enter native views or ordinary rows and reach only approved register options", async () => {
  const f = await fixture(false, 1, false, "", "", true),
    signal = new AbortController().signal
  const initial = await f.manager.userConfig(f.root, "thread", "p", signal, () => {})
  expect(initial.fields.find((field) => field.key === "token")).toMatchObject({
    supported: true,
    sensitive: true,
    secretState: "unset"
  })
  await expect(f.manager.commands(f.root, "thread")).rejects.toThrow("token")
  expect(f.load).not.toHaveBeenCalled()
  const saved = await f.manager.saveSensitiveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "token",
    { operation: "set", value: "first-private" },
    0,
    signal,
    () => {}
  )
  expect(JSON.stringify(saved)).not.toContain("first-private")
  const first = await f.manager.commands(f.root, "thread")
  expect(JSON.parse(first[0].name).token).toBe("first-private")
  expect(f.load.mock.calls[0][1].token).toBe("first-private")
  expect(
    (await f.manager.configList(f.root, "thread", signal, () => {})).some((row) =>
      row.key.endsWith(".token")
    )
  ).toBe(false)
  await expect(
    f.manager.configSet(
      f.root,
      "thread",
      "config-options.token",
      "raw",
      { kind: "composer" },
      signal,
      () => {}
    )
  ).rejects.toThrow("MODS_CONFIG_UNKNOWN_KEY")
  await expect(
    f.manager.pickUserConfigPath(
      f.root,
      "thread",
      "p",
      f.compiled.digest,
      "hiddenFile",
      1,
      signal,
      () => {},
      async () => "private-path"
    )
  ).rejects.toThrow("MODS_CONFIG_PATH_FIELD")
  f.busy(true)
  const pending = await f.manager.saveSensitiveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "token",
    { operation: "set", value: "second-private" },
    1,
    signal,
    () => {}
  )
  expect(pending.state).toBe("pending")
  expect(pending.fields.find((field) => field.key === "token")).toMatchObject({
    secretState: "saved",
    effectiveConfigured: true
  })
  expect(JSON.stringify(pending)).not.toMatch(/first-private|second-private/)
  const nativePublications = f.publish.mock.calls.filter(
    ([, value]) =>
      value && !Array.isArray(value) && typeof value === "object" && Array.isArray(value.fields)
  )
  expect(JSON.stringify(nativePublications)).not.toMatch(/first-private|second-private/)
  expect(JSON.parse((await f.manager.commands(f.root, "thread"))[0].name).token).toBe(
    "first-private"
  )
  f.busy(false)
  expect(JSON.parse((await f.manager.commands(f.root, "thread"))[0].name).token).toBe(
    "second-private"
  )
})

it("publication cannot inject a plaintext value or choices back into a confidential field", async () => {
  const f = await fixture(false, 1, false, "", "", true)
  f.publish.mockImplementation(async (_workspace, value) => {
    const safe = filterModData(value, true)
    if (safe && !Array.isArray(safe) && typeof safe === "object" && Array.isArray(safe.fields))
      return {
        ...safe,
        fields: safe.fields.map((field) => ({
          ...(field as object),
          value: "injected",
          options: ["injected"]
        }))
      }
    return safe
  })
  const view = await f.manager.userConfig(
    f.root,
    "thread",
    "p",
    new AbortController().signal,
    () => {}
  )
  const token = view.fields.find((field) => field.key === "token")!
  expect(token.value).toBeUndefined()
  expect(token.options).toBeUndefined()
  expect(token.effectiveValue).toBeUndefined()
})

it("registration probes cannot decrypt saved secrets for revoked or changed unapproved code", async () => {
  const f = await fixture(false, 1, false, "", "", true)
  f.values.saveSensitive(
    f.root,
    "config-options",
    f.compiled.userConfig!,
    "token",
    { operation: "set", value: "private-probe-sentinel" },
    0,
    () => {}
  )
  f.store.grant(f.root, "function:config-options", f.compiled.digest, false)
  await expect(f.manager.checkCompatibility(f.root, "p", f.compiled.digest)).rejects.toThrow(
    "MODS_SECRET_CODE_APPROVAL_REQUIRED"
  )
  expect(f.load).not.toHaveBeenCalled()
  f.store.grant(f.root, "function:config-options", f.compiled.digest, true)
  await writeFile(
    join(f.path, "hooks/register.ts"),
    "export function register(on, options) { on('diagnostic.' + options.token, () => {}) }"
  )
  const next = await compileFunctionPlugin(f.path)
  expect(next.digest).not.toBe(f.compiled.digest)
  await expect(f.manager.checkCompatibility(f.root, "p", next.digest)).rejects.toThrow(
    "MODS_SECRET_CODE_APPROVAL_REQUIRED"
  )
  expect(f.load).not.toHaveBeenCalled()
  await f.manager.approve(f.root, "p", next.digest)
  expect(f.load.mock.calls[0][1].token).toBe("private-probe-sentinel")
  await expect(f.manager.checkCompatibility(f.root, "p", next.digest)).resolves.toHaveProperty(
    "digest",
    next.digest
  )
})

it("revocation with reapproval or a source replacement during decryption cannot load the captured secret", async () => {
  for (const change of ["grant", "source"]) {
    const f = await fixture(false, 1, false, "", "", true)
    f.values.saveSensitive(
      f.root,
      "config-options",
      f.compiled.userConfig!,
      "token",
      { operation: "set", value: "private-probe-sentinel" },
      0,
      () => {}
    )
    const decrypt = f.protector.decryptString.bind(f.protector)
    f.protector.decryptString = (bytes) => {
      const value = decrypt(bytes)
      if (change === "grant") {
        f.store.grant(f.root, "function:config-options", f.compiled.digest, false)
        f.store.grant(f.root, "function:config-options", f.compiled.digest, true)
      } else writeFileSync(join(f.path, "hooks/register.ts"), "export function register() {}")
      return value
    }
    await expect(f.manager.checkCompatibility(f.root, "p", f.compiled.digest)).rejects.toThrow(
      change === "grant" ? "MODS_GRANT_REVOKED" : "MODS_CONFIG_SOURCE_CHANGED"
    )
    expect(f.load).not.toHaveBeenCalled()
  }
})

it("protected mixed file schemas keep ordinary fields editable without publishing type facts", async () => {
  const f = await fixture(false, 1, true)
  const signal = new AbortController().signal
  const view = await f.manager.userConfig(f.root, "thread", "p", signal, () => {})
  expect(view.fields.find((field) => field.key === "path")).toMatchObject({
    type: "file",
    supported: true,
    label: "Path"
  })
  const saved = await f.manager.saveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "tone",
    "formal",
    0,
    signal,
    () => {}
  )
  expect(saved.fields.find((field) => field.key === "tone")?.value).toBe("formal")
  expect(f.load).not.toHaveBeenCalled()
})

it("actual file/dir rows are text while native lists stay out of SDK rows and reach a new register snapshot", async () => {
  const f = await fixture(false, 1, true)
  const signal = new AbortController().signal
  f.busy(true)
  const commands = await f.manager.commands(f.root, "thread")
  expect(JSON.parse(commands[0].name)).toMatchObject({ list: ["a,b"], scalarList: "a,b\nc" })
  const rows = await f.manager.configList(f.root, "thread", signal, () => {})
  expect(rows.find((row) => row.key === "config-options.path")).toMatchObject({
    kind: "text",
    value: ""
  })
  expect(rows.find((row) => row.key === "config-options.directory")).toMatchObject({ kind: "text" })
  expect(rows.some((row) => row.key === "config-options.list")).toBe(false)
  await expect(
    f.manager.configSet(
      f.root,
      "thread",
      "config-options.list",
      ["a", "b"],
      { kind: "composer" },
      signal,
      () => {}
    )
  ).rejects.toThrow("MODS_CONFIG_UNKNOWN_KEY")
  const saved = await f.manager.saveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "list",
    ["a", "b\nc"],
    0,
    signal,
    () => {}
  )
  expect(saved.state).toBe("pending")
  expect(saved.fields.find((field) => field.key === "list")).toMatchObject({
    multiple: true,
    value: ["a", "b\nc"]
  })
  expect(f.values.read(f.root, f.compiled.name).values.list).toEqual(["a", "b\nc"])
  const path = await f.manager.saveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "path",
    "some-file",
    1,
    signal,
    () => {}
  )
  expect(path.fields.find((field) => field.key === "path")?.value).toBe("some-file")
  f.busy(false)
  const next = await f.manager.commands(f.root, "thread")
  expect(JSON.parse(next[0].name)).toMatchObject({
    list: ["a", "b\nc"],
    path: "some-file",
    scalarList: "a,b\nc"
  })
})

it("an active file setting Hook denial never falls back to native direct persistence", async () => {
  const f = await fixture(
    false,
    1,
    true,
    "",
    'on("config.set",{key:"config-options.path"},async()=>({deny:"path policy"}))'
  )
  await f.manager.commands(f.root, "thread")
  await expect(
    f.manager.saveUserConfig(
      f.root,
      "thread",
      "p",
      f.compiled.digest,
      "path",
      "must not persist",
      0,
      new AbortController().signal,
      () => {}
    )
  ).rejects.toThrow("path policy")
  expect(f.values.read(f.root, f.compiled.name)).toEqual({ revision: 0, values: {} })
})

it("the final real picker view publication cannot accept schema changed at the same path", async () => {
  const f = await fixture(false, 1, true)
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  let views = 0
  f.publish.mockImplementation(async (_workspace, value) => {
    if (
      value &&
      !Array.isArray(value) &&
      typeof value === "object" &&
      Array.isArray(value.fields) &&
      ++views === 3
    ) {
      entered.resolve()
      await finish.promise
    }
    return filterModData(value, true)
  })
  const choose = vi.fn(async () => "selected-file")
  const pending = f.manager.pickUserConfigPath(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "path",
    0,
    new AbortController().signal,
    () => {},
    choose
  )
  const rejected = expect(pending).rejects.toThrow("MODS_CONFIG_SOURCE_CHANGED")
  await entered.promise
  const manifest = JSON.parse(await readFile(join(f.path, "plugin.json"), "utf8"))
  manifest.userConfig.path.sensitive = true
  await writeFile(join(f.path, "plugin.json"), JSON.stringify(manifest))
  finish.resolve()
  await rejected
  expect(choose).toHaveBeenCalledOnce()
  expect(f.load).not.toHaveBeenCalled()
  expect(f.values.read(f.root, f.compiled.name)).toEqual({ revision: 0, values: {} })
})

it("a config Hook that changes the actual schema cannot commit using the old writer", async () => {
  const f = await fixture(
    false,
    1,
    true,
    "",
    'on("config.set",{key:"config-options.path"},async($,e,next)=>next({...e,value:"changed-by-hook"}))'
  )
  await f.manager.commands(f.root, "thread")
  const events: string[] = []
  const originalWrite = f.store.setSetting.bind(f.store)
  vi.spyOn(f.store, "setSetting").mockImplementation((key, value) => {
    if (key.startsWith("function-user-config:")) events.push("write")
    originalWrite(key, value)
  })
  f.publish.mockImplementation(async (_workspace, value) => {
    if (
      value &&
      !Array.isArray(value) &&
      typeof value === "object" &&
      value.key === "config-options.path" &&
      value.value === "changed-by-hook"
    ) {
      events.push("schema")
      const manifest = JSON.parse(await readFile(join(f.path, "plugin.json"), "utf8"))
      manifest.userConfig.path.type = "directory"
      await writeFile(join(f.path, "plugin.json"), JSON.stringify(manifest))
    }
    return filterModData(value, true)
  })
  await expect(
    f.manager.saveUserConfig(
      f.root,
      "thread",
      "p",
      f.compiled.digest,
      "path",
      "must not persist",
      0,
      new AbortController().signal,
      () => {}
    )
  ).rejects.toThrow("MODS_CONFIG_SOURCE_CHANGED")
  expect(events).toEqual(["schema"])
  expect(f.values.read(f.root, f.compiled.name)).toEqual({ revision: 0, values: {} })
})

it("legacy cold loading and an empty parameter view survive an ignored oversized manifest", async () => {
  const f = await fixture(false, 2)
  const second = join(f.root, "second", ".claude-plugin")
  await mkdir(second)
  await writeFile(join(second, "plugin.json"), " ".repeat(32769))
  await expect(f.manager.commands(f.root, "thread")).resolves.toHaveLength(1)
  await expect(
    f.manager.userConfig(f.root, "thread", "q", new AbortController().signal, () => {})
  ).resolves.toMatchObject({ fields: [], state: "applied" })
})

it("pending parameters cannot generate new completion or Flow evidence from the previous guest", async () => {
  const f = await fixture()
  f.busy(true)
  await f.manager.commands(f.root, "thread")
  f.store.functionState.set(JSON.stringify([f.root, "config-options"]), "completion-config", {
    ...DEFAULT_COMPLETION_POLICY,
    mode: "report",
    scope: "project"
  })
  await f.manager.saveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "tone",
    "formal",
    0,
    new AbortController().signal,
    () => {}
  )
  await expect(
    f.manager.completionGate(f.root, "thread", () => ({ turnId: "turn" }))
  ).rejects.toThrow("插件参数已保存")
  await expect(
    f.manager.prepareFlowScope(
      f.root,
      "thread",
      undefined,
      "run",
      "definition",
      new AbortController().signal
    )
  ).rejects.toThrow("插件参数已保存")
  expect(f.load).toHaveBeenCalledOnce()
})

it("original-package defaults and actual stored values reach the real register snapshot", async () => {
  const f = await fixture()
  f.values.save(f.root, "config-options", f.compiled.userConfig!, "tone", "formal", 0, () => {})
  const commands = await f.manager.commands(f.root, "thread")
  expect(JSON.parse(commands[0].name)).toEqual({ tone: "formal", flag: false, budget: 0 })
  expect(f.load.mock.calls[0][1]).toEqual({ tone: "formal", flag: false, budget: 0 })
  expect((await compileFunctionPlugin(f.path)).digest).toBe(f.compiled.digest)
})

it("native required-value configuration works before approval without running any guest", async () => {
  const f = await fixture(true)
  f.manager.revoke(f.root, "config-options")
  const signal = new AbortController().signal
  const initial = await f.manager.userConfig(f.root, "thread", "p", signal, () => {})
  expect(initial.state).toBe("inactive")
  expect(initial.fields.find((field) => field.key === "tone")?.value).toBeUndefined()
  const saved = await f.manager.saveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "tone",
    "formal",
    0,
    signal,
    () => {}
  )
  expect(saved.savedRevision).toBe(1)
  expect(saved.state).toBe("inactive")
  expect(f.load).not.toHaveBeenCalled()
  await f.manager.approve(f.root, "p", f.compiled.digest)
  expect((await f.manager.commands(f.root, "thread"))[0].name).toContain("formal")
})

it("real saved/effective values diverge honestly while a previous registered guest remains alive", async () => {
  const f = await fixture()
  f.busy(true)
  await f.manager.commands(f.root, "thread")
  const signal = new AbortController().signal
  const saved = await f.manager.saveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "tone",
    "formal",
    0,
    signal,
    () => {}
  )
  expect(saved.state).toBe("pending")
  expect(saved.savedRevision).toBe(1)
  expect(saved.effectiveRevision).toBe(0)
  expect(saved.fields.find((field) => field.key === "tone")).toMatchObject({
    value: "formal",
    effectiveValue: "warm"
  })
  expect((await f.manager.commands(f.root, "thread"))[0].name).toContain("warm")
  expect(f.load).toHaveBeenCalledOnce()
})

it("native value saving rejects stale schema, revision and original owner without writes", async () => {
  const f = await fixture()
  const signal = new AbortController().signal
  await expect(
    f.manager.saveUserConfig(f.root, "thread", "p", "stale", "tone", "formal", 0, signal, () => {})
  ).rejects.toThrow("MODS_CONFIG_SOURCE_CHANGED")
  await expect(
    f.manager.saveUserConfig(
      f.root,
      "thread",
      "p",
      f.compiled.digest,
      "tone",
      "formal",
      3,
      signal,
      () => {}
    )
  ).rejects.toThrow("MODS_CONFIG_VALUE_CHANGED")
  await expect(
    f.manager.saveUserConfig(
      f.root,
      "thread",
      "p",
      f.compiled.digest,
      "tone",
      "formal",
      0,
      signal,
      () => {
        throw Error("owner changed")
      }
    )
  ).rejects.toThrow("owner changed")
  expect(f.values.read(f.root, "config-options")).toEqual({ revision: 0, values: {} })
  expect(f.load).not.toHaveBeenCalled()
})

it("ordinary boolean and number writes reject loader-unset empty text", async () => {
  const f = await fixture()
  await f.manager.commands(f.root, "thread")
  const signal = new AbortController().signal
  for (const field of ["flag", "budget"]) {
    expect(
      await f.manager.configSet(
        f.root,
        "thread",
        `config-options.${field}`,
        "",
        { kind: "composer" },
        signal,
        () => {}
      )
    ).toMatchObject({ deny: expect.any(String) })
    await expect(
      f.manager.saveUserConfig(
        f.root,
        "thread",
        "p",
        f.compiled.digest,
        field,
        "",
        0,
        signal,
        () => {}
      )
    ).rejects.toThrow("The value does not fit")
  }
  expect(f.values.read(f.root, "config-options")).toEqual({ revision: 0, values: {} })
})

it("idle application adopts a completely initialized guest with the actual saved options", async () => {
  const f = await fixture()
  await f.manager.commands(f.root, "thread")
  await f.manager.saveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "tone",
    "formal",
    0,
    new AbortController().signal,
    () => {}
  )
  expect((await f.manager.commands(f.root, "thread"))[0].name).toContain("formal")
  const view = await f.manager.userConfig(
    f.root,
    "thread",
    "p",
    new AbortController().signal,
    () => {}
  )
  expect(view).toMatchObject({ state: "applied", savedRevision: 1, effectiveRevision: 1 })
  expect(f.load).toHaveBeenCalledTimes(2)
  await f.manager.saveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "tone",
    "formal",
    1,
    new AbortController().signal,
    () => {}
  )
  await f.manager.commands(f.root, "thread")
  expect(f.load).toHaveBeenCalledTimes(2)
})

it("a perpetual timer does not permanently occupy the session between its entered callbacks", async () => {
  const f = await fixture(false, 1, false, 'if(options.tone==="warm")$.clock.every(10,()=>{})')
  f.busy(true)
  await f.manager.commands(f.root, "thread")
  await f.manager.saveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "tone",
    "formal",
    0,
    new AbortController().signal,
    () => {}
  )
  f.busy(false)
  await vi.waitFor(() => expect(f.load).toHaveBeenCalledTimes(2), { timeout: 2500 })
  const view = await f.manager.userConfig(
    f.root,
    "thread",
    "p",
    new AbortController().signal,
    () => {}
  )
  expect(view).toMatchObject({ state: "applied", effectiveRevision: 1 })
})

it("an SDK save returns its durable ACK before safely retiring the saving guest", async () => {
  const f = await fixture(
    false,
    1,
    false,
    'await $.state.get({plugin:"config-options",key:"startup-read"})',
    `
    on("command.run",async($)=>{const saved=await $.config.set({key:"config-options.tone",value:"formal"});
      await $.store.set("ack",saved);return {text:JSON.stringify({saved,tone:options.tone})}})
  `
  )
  const descriptor = (await f.manager.commands(f.root, "thread"))[0]
  const result = await f.manager.runCommand(
    f.root,
    "thread",
    descriptor,
    "",
    new AbortController().signal
  )
  expect(JSON.parse(String(result.text))).toEqual({ saved: { value: "formal" }, tone: "warm" })
  expect(f.store.functionState.get(JSON.stringify([f.root, "config-options"]), "ack")).toEqual({
    value: "formal"
  })
  expect((await f.manager.commands(f.root, "thread"))[0].name).toContain("formal")
  expect(
    await f.manager.userConfig(f.root, "thread", "p", new AbortController().signal, () => {})
  ).toMatchObject({ state: "applied", savedRevision: 1, effectiveRevision: 1 })
})

it("background application contains corrupt saves and failed host notifications", async () => {
  const f = await fixture(
    false,
    1,
    false,
    'if(options.tone==="formal")throw Error("candidate failed")'
  )
  await f.manager.commands(f.root, "thread")
  f.configChanged.mockImplementation(() => {
    throw Error("notification failed")
  })
  f.store.setSetting(
    "function-user-config:" + JSON.stringify([f.root, "config-options"]),
    '{"revision":-1,"values":{}}'
  )
  // Quiet reads release an actual entry lease and trigger the production idle callback.
  await f.manager.logs(f.root, "thread")
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.load).toHaveBeenCalledOnce()
  await expect(
    f.manager.userConfig(f.root, "thread", "p", new AbortController().signal, () => {})
  ).rejects.toThrow("MODS_USER_CONFIG_STORE")
  f.store.setSetting(
    "function-user-config:" + JSON.stringify([f.root, "config-options"]),
    '{"revision":1,"values":{"tone":"formal"}}'
  )
  const view = await f.manager.userConfig(
    f.root,
    "thread",
    "p",
    new AbortController().signal,
    () => {}
  )
  expect(view.state).toBe("failed")
  expect(view.error).toContain("MODS_USER_CONFIG_STORE")
  expect((await f.manager.commands(f.root, "thread"))[0].name).toContain("warm")
})

it("caught startup effects cannot fake adoption or mutate storage, and the old guest stays usable", async () => {
  const f = await fixture(
    false,
    1,
    false,
    'if(options.tone==="formal"){try{await $.store.set("effect",1)}catch{}}'
  )
  await f.manager.commands(f.root, "thread")
  await f.manager.saveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "tone",
    "formal",
    0,
    new AbortController().signal,
    () => {}
  )
  expect((await f.manager.commands(f.root, "thread"))[0].name).toContain("warm")
  const view = await f.manager.userConfig(
    f.root,
    "thread",
    "p",
    new AbortController().signal,
    () => {}
  )
  expect(view).toMatchObject({ state: "failed", savedRevision: 1, effectiveRevision: 0 })
  expect(view.error).toContain("store.set")
  expect(
    f.store.functionState.get(JSON.stringify([f.root, "config-options"]), "effect")
  ).toBeUndefined()
  const calls = f.load.mock.calls.length
  await f.manager.commands(f.root, "thread")
  expect(f.load).toHaveBeenCalledTimes(calls)
})

it("a recovered startup error does not replace an otherwise working previous registration", async () => {
  const f = await fixture(
    false,
    1,
    false,
    'if(options.tone==="formal")throw Error("broken startup")'
  )
  await f.manager.commands(f.root, "thread")
  await f.manager.saveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "tone",
    "formal",
    0,
    new AbortController().signal,
    () => {}
  )
  expect((await f.manager.commands(f.root, "thread"))[0].name).toContain("warm")
  expect(
    await f.manager.userConfig(f.root, "thread", "p", new AbortController().signal, () => {})
  ).toMatchObject({ state: "failed", effectiveRevision: 0 })
})

it("a native task keeps its register snapshot across calls, then idle applies the next version", async () => {
  const f = await fixture()
  f.busy(true)
  await f.manager.commands(f.root, "thread")
  await f.manager.saveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "tone",
    "formal",
    0,
    new AbortController().signal,
    () => {}
  )
  expect((await f.manager.commands(f.root, "thread"))[0].name).toContain("warm")
  expect((await f.manager.commands(f.root, "thread"))[0].name).toContain("warm")
  expect(f.load).toHaveBeenCalledOnce()
  f.busy(false)
  expect((await f.manager.commands(f.root, "thread"))[0].name).toContain("formal")
})

it("a saved revision changed during private candidate construction cannot be adopted", async () => {
  const f = await fixture()
  f.busy(true)
  await f.manager.commands(f.root, "thread")
  await f.manager.saveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "tone",
    "formal",
    0,
    new AbortController().signal,
    () => {}
  )
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const actual = f.load.getMockImplementation()!
  f.load.mockImplementationOnce(async (...args) => {
    entered.resolve()
    await release.promise
    return actual(...args)
  })
  f.busy(false)
  const request = f.manager.commands(f.root, "thread")
  await entered.promise
  f.values.save(f.root, "config-options", f.compiled.userConfig!, "tone", "newest", 1, () => {})
  release.resolve()
  expect((await request)[0].name).toContain("warm")
  expect(
    await f.manager.userConfig(f.root, "thread", "p", new AbortController().signal, () => {})
  ).toMatchObject({ state: "failed", savedRevision: 2, effectiveRevision: 0 })
})

it("the final second-package await cannot hide a changed first-package source", async () => {
  const f = await fixture(false, 2)
  f.busy(true)
  await f.manager.commands(f.root, "thread")
  await f.manager.saveUserConfig(
    f.root,
    "thread",
    "p",
    f.compiled.digest,
    "tone",
    "formal",
    0,
    new AbortController().signal,
    () => {}
  )
  const actual = loader.compileFunctionPlugin
  let secondReads = 0
  const compile = vi.spyOn(loader, "compileFunctionPlugin").mockImplementation(async (...args) => {
    const snapshot = await actual(...args)
    if (args[0] === join(f.root, "second") && ++secondReads === 2)
      await writeFile(join(f.path, "hooks/register.ts"), "export function register() {}")
    return snapshot
  })
  try {
    f.busy(false)
    expect((await f.manager.commands(f.root, "thread"))[0].name).toContain("warm")
    expect(secondReads).toBe(2)
    const view = await f.manager.userConfig(
      f.root,
      "thread",
      "p",
      new AbortController().signal,
      () => {}
    )
    expect(view.error).toContain("MODS_CONFIG_SOURCE_CHANGED")
    expect(view.effectiveRevision).toBeUndefined()
  } finally {
    compile.mockRestore()
  }
})

it("a first plugin changed while a second loads is rejected before session initialization", async () => {
  const f = await fixture(false, 2)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const actual = f.load.getMockImplementation()!
  let first: FunctionGuestRuntime | undefined
  const invocations = vi.fn()
  f.load.mockImplementation(async (code, options) => {
    if (!first) {
      first = await actual(code, options)
      const invoke = first.invoke.bind(first)
      first.invoke = (...args) => {
        invocations()
        return invoke(...args)
      }
      return first
    }
    entered.resolve()
    await release.promise
    return actual(code, options)
  })
  const request = f.manager.commands(f.root, "thread")
  const rejected = expect(request).rejects.toThrow("MODS_CONFIG_VALUE_CHANGED")
  await entered.promise
  f.values.save(f.root, "config-options", f.compiled.userConfig!, "tone", "formal", 0, () => {})
  release.resolve()
  await rejected
  expect(invocations).not.toHaveBeenCalled()
  f.load.mockImplementation(actual)
  expect((await f.manager.commands(f.root, "thread"))[0].name).toContain("formal")
})

it("missing required configuration fails before any guest loads", async () => {
  const f = await fixture(true)
  await expect(f.manager.commands(f.root, "thread")).rejects.toThrow("tone")
  expect(f.load).not.toHaveBeenCalled()
})

it("configuration changed while a guest loads cannot activate that previous options snapshot", async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const actual = f.load.getMockImplementation()!
  f.load.mockImplementationOnce(async (code, options) => {
    entered.resolve()
    await release.promise
    return actual(code, options)
  })
  const request = f.manager.commands(f.root, "thread")
  const rejected = expect(request).rejects.toThrow("MODS_CONFIG_VALUE_CHANGED")
  await entered.promise
  f.values.save(f.root, "config-options", f.compiled.userConfig!, "tone", "formal", 0, () => {})
  release.resolve()
  await rejected
  expect((await f.manager.commands(f.root, "thread"))[0].name).toContain("formal")
})
