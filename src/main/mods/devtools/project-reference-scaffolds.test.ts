import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { afterEach, expect, it } from "vitest"
import type { PluginMetadata } from "../../types"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import type { DevelopmentScope } from "../v2/development-session"
import { compileFunctionPlugin } from "../v2/loader"
import { ModControlStore } from "../control-store"
import { compileNativeComposition, nativeCompositionSchema } from "../../plugins/native-composition"
import { createProjectTemplate } from "./project-template"
import { readProjectSource } from "./project-source"
import { projectFromInstalledPlugin } from "./project-from-plugin"
import { ProjectAuthoringSessions } from "./project-authoring-session"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

// Compiled provider descriptors prove authoring compatibility only. No installed grants,
// model execution, Host project completion or real business acceptance are manufactured here.
it.each(["native-modular", "autobiz-lean"] as const)(
  "retains and derives the actual %s scaffold through the same authoring lifecycle",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "project-reference-scaffold-"))
    cleanup.push(async () => {
      if (
        dirname(resolve(root)) !== resolve(tmpdir()) ||
        !root.startsWith(join(tmpdir(), "project-reference-scaffold-"))
      )
        throw Error("Unsafe test cleanup")
      await rm(root, { recursive: true, force: true })
    })
    const store = new ModControlStore(join(root, "settings.sqlite"))
    cleanup.push(async () => store.close())
    const actions: ClawActionDescriptor[] = []
    let bundle
    if (kind === "autobiz-lean") {
      const sourceRoot = resolve("resources/native-compositions/autobiz-lean")
      for (const name of ["knowledge", "rules", "delivery"]) {
        const provider = await compileFunctionPlugin(join(sourceRoot, "providers", name))
        if (!provider?.actions) throw Error("Reference provider compilation failed")
        actions.push(
          ...provider.actions.map(({ id, ...action }) => ({
            ...action,
            actionId: id,
            pluginId: `fixture-${name}`,
            plugin: provider.name,
            digest: provider.digest
          }))
        )
      }
      bundle = (await readProjectSource(join(sourceRoot, "project"))).bundle
    } else {
      bundle = createProjectTemplate({
        packageId: "reference-report",
        name: "资料整理模板",
        template: kind
      })
    }
    const source = nativeCompositionSchema.parse(
      JSON.parse(bundle.files.find((file) => file.path === "composition/source.json")!.text)
    )
    const built = compileNativeComposition(source, {
      files: bundle.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.text) })),
      actionCatalog: actions
    })
    const installed = join(root, "installed")
    for (const file of built.files) {
      await mkdir(dirname(join(installed, file.path)), { recursive: true })
      await writeFile(join(installed, file.path), file.bytes)
    }
    const original = (await readProjectSource(installed)).bundle
    const scope: DevelopmentScope = {
      threadId: "reference-author",
      workspace: root,
      incarnation: { token: "reference-author-incarnation", legacyCreatedAt: 1 }
    }
    const sessions = new ProjectAuthoringSessions(async () => actions)
    sessions.configurePersistence(store, join(root, "drafts"))
    const plugin = {
      id: "installed-reference",
      name: source.plugin.id,
      version: source.plugin.version,
      path: installed,
      enabled: true,
      updatedAt: "fixture"
    } as PluginMetadata
    const imported = await projectFromInstalledPlugin({
      scope,
      pluginId: plugin.id,
      id: "derived-reference",
      plugins: () => [plugin],
      sessions,
      guard: () => {}
    })
    expect(imported.requiresFreshTrial).toBe(true)
    expect(imported.draft.source).toEqual(original)
    const skillPath = source.modules[0].skill
    const skill = original.files.find((file) => file.path === skillPath)!
    const appended = "\n逐项说明本阶段仍缺少的依据，不把推测写成已验证事实。\n"
    const edited = await sessions.patch(
      scope,
      {
        id: imported.draft.id,
        revision: imported.draft.revision,
        sourceDigest: imported.draft.source.digest,
        files: [{ path: skillPath, text: skill.text + appended }],
        sourcePatch: [{ op: "replace", path: "/plugin/title", value: "独立派生模板" }]
      },
      () => {}
    )
    const compiled = await sessions.compile(scope, edited.id, edited.revision, () => {})
    expect(compiled.source.files.find((file) => file.path === skillPath)?.text).toBe(
      skill.text + appended
    )
    const actual = nativeCompositionSchema.parse(
      JSON.parse(
        compiled.source.files.find((file) => file.path === "composition/source.json")!.text
      )
    )
    expect(actual.modules).toEqual(source.modules)
    expect(actual.configuration).toEqual(source.configuration)
    for (const path of source.resources) {
      expect(compiled.source.files.find((file) => file.path === path)).toEqual(
        original.files.find((file) => file.path === path)
      )
    }
    expect(
      await sessions.inspect(scope, compiled.id, compiled.revision, "doctor", () => {}, actions)
    ).toMatchObject({ valid: true })
    expect((await readProjectSource(installed)).bundle).toEqual(original)
    expect(sessions.trialRequest(scope)).toBeUndefined()
    const secondInstalled = join(root, "installed-derived")
    for (const file of compiled.source.files) {
      await mkdir(dirname(join(secondInstalled, file.path)), { recursive: true })
      await writeFile(join(secondInstalled, file.path), file.text)
    }
    const secondPlugin = { ...plugin, id: "installed-derived", path: secondInstalled }
    const second = await projectFromInstalledPlugin({
      scope,
      pluginId: secondPlugin.id,
      id: "derived-again",
      plugins: () => [secondPlugin],
      sessions,
      guard: () => {}
    })
    expect(second.requiresFreshTrial).toBe(true)
    expect(second.draft.source).toEqual(compiled.source)
    expect(second.draft.source.files.find((file) => file.path === skillPath)?.text).toBe(
      skill.text + appended
    )
    expect((await readProjectSource(secondInstalled)).bundle).toEqual(compiled.source)
    const restored = new ProjectAuthoringSessions(async () => actions)
    restored.configurePersistence(store, join(root, "drafts"))
    expect(restored.read(scope, compiled.id).source).toEqual(compiled.source)
    expect(restored.read(scope, second.draft.id).source).toEqual(compiled.source)
    expect(restored.trialRequest(scope)).toBeUndefined()
  },
  30_000
)
