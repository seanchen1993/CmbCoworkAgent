import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"
import { getOpenworkDir, getPlugins } from "../../src/main/storage"
import { ModsManager } from "../../src/main/mods/manager"
import { FunctionModsManager } from "../../src/main/mods/v2/manager"
import { createAuthoringInstallService } from "../../src/main/mods/devtools/authoring-install-factory"
import { AuthoringDraftStore } from "../../src/main/mods/devtools/authoring-store"
import { createAuthoringTemplate } from "../../src/main/mods/devtools/authoring-templates"
import { createAuthoringSourceBundle } from "../../src/main/mods/devtools/authoring-bundle"
import { pluginCatalogGate } from "../../src/main/plugins/catalog-gate"
import { installPluginFromDir, registerPluginHandlers } from "../../src/main/ipc/plugins"
import type { IpcMain } from "electron"

app.setPath("userData", process.env.CMB_COWORK_AGENT_HOME!)
void app
  .whenReady()
  .then(async () => {
    const root = getOpenworkDir()
    const manager = new ModsManager(
      join(root, "control.sqlite"),
      getPlugins,
      async () => false,
      () => {}
    )
    let publish: (value: unknown) => Promise<unknown> = async (value) => value
    const functions = new FunctionModsManager(manager.store, {
      plugins: getPlugins,
      enabled: () => true,
      publish: async (_workspace, value) => (await publish(value)) as typeof value,
      changed: () => {}
    })
    const service = createAuthoringInstallService(manager, functions)
    const drafts = new AuthoringDraftStore(manager.store)
    const scope = () => ({
      workspace: root,
      signal: new AbortController().signal,
      assertCurrent: () => {}
    })
    const save = (revision: number, instruction: string) => {
      const template = createAuthoringTemplate({
        id: "installed-command",
        name: "Installed",
        kind: "command",
        instruction
      })
      const source = createAuthoringSourceBundle(
        template.files.map((file) =>
          file.path === "mods/manifest.json"
            ? {
                ...file,
                text: JSON.stringify({
                  apiVersion: "cmb.mods/v2",
                  id: "installed-command",
                  entry: "main.ts"
                })
              }
            : file
        )
      )
      drafts.save({
        workspace: root,
        id: "draft",
        name: "Draft",
        source,
        expectedRevision: revision,
        assertCurrent: () => {}
      })
      return { draftId: "draft", revision: revision + 1, sourceDigest: source.digest }
    }
    const apply = (prepared: Awaited<ReturnType<typeof service.prepare>>) =>
      service.apply(
        { handle: prepared.handle, expectedCatalogDigest: prepared.catalogDigest },
        scope()
      )
    const approve = async (threadId = "thread") => {
      const status = (await functions.status(root))[0]
      assert.equal(status.state, "needs-approval")
      await functions.approve(root, status.pluginId, status.digest!)
      return (await functions.commands(root, threadId))[0]
    }
    try {
      const first = await service.prepare(save(0, "version one"), scope())
      assert(first.review.sdkMethods.includes("command.register"))
      assert.equal(first.review.typesValid, true)
      assert.equal(getPlugins().length, 0)
      assert.equal((await apply(first)).state, "settled")
      const firstPath = getPlugins()[0].path
      const original = readFileSync(join(firstPath, "mods/main.ts"), "utf8")
      assert.equal((await installPluginFromDir(firstPath)).success, false)
      assert.equal(readFileSync(join(firstPath, "mods/main.ts"), "utf8"), original)
      const command = await approve()
      assert(command)
      let started!: () => void, release!: () => void
      const entered = new Promise<void>((resolve) => {
        started = resolve
      })
      const delay = new Promise<void>((resolve) => {
        release = resolve
      })
      publish = async (value) => {
        started()
        await delay
        return value
      }
      const running = functions.runCommand(
        root,
        "thread",
        command,
        "sample",
        new AbortController().signal
      )
      await entered
      const second = await service.prepare(save(1, "version two"), scope())
      await assert.rejects(apply(second), /PLUGIN_CATALOG_BUSY/)
      assert.equal(getPlugins()[0].path, firstPath)
      release()
      const previous = await running
      assert.match(previous.text, /version one/)
      publish = async (value) => value
      assert.equal((await apply(second)).state, "settled")
      assert.equal(readFileSync(join(firstPath, "mods/main.ts"), "utf8"), original)
      const nextCommand = await approve("next-thread")
      assert.match(
        (
          await functions.runCommand(
            root,
            "next-thread",
            nextCommand,
            "sample",
            new AbortController().signal
          )
        ).text,
        /version two/
      )
      const rollback = await service.rollbackPrepare(
        {
          installationId: first.installationId,
          versionId: first.versionId,
          restoreConfiguration: true
        },
        scope()
      )
      assert.equal((await apply(rollback)).state, "settled")
      const oldCommand = await approve("rollback-thread")
      assert.match(
        (
          await functions.runCommand(
            root,
            "rollback-thread",
            oldCommand,
            "sample",
            new AbortController().signal
          )
        ).text,
        /version one/
      )
      assert.equal(pluginCatalogGate.activityCount, 0)
      const uncertain = await service.prepare(save(2, "version three"), scope())
      const partial = await service.apply({ handle: uncertain.handle, expectedCatalogDigest: uncertain.catalogDigest }, {
        ...scope(), assertCurrent: () => {
          if (getPlugins().some(plugin => plugin.path.includes(uncertain.versionId))) throw Error("scope revoked after index write")
        }
      })
      assert.equal(partial.state, "partial")
      const reopened = createAuthoringInstallService(manager, functions)
      const observation = reopened.inspectUncertain({ operationId: partial.operationId }, scope())
      assert.equal(observation.catalog, "after")
      const beforeReconcile = JSON.stringify(getPlugins())
      assert.equal((await reopened.reconcile({ operationId: partial.operationId, expectedInspectionDigest: observation.inspectionDigest }, scope())).state, "reconciled")
      assert.equal(JSON.stringify(getPlugins()), beforeReconcile)
      assert.equal(reopened.list(scope()).installations[0].currentVersionId, uncertain.versionId)
      assert.equal(reopened.list(scope()).installations[0].pending, undefined)
      assert.equal((await functions.status(root))[0].state, "needs-approval")
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
      registerPluginHandlers({
        handle: (name, handler) => handlers.set(name, handler as never)
      } as IpcMain)
      const removed = (await handlers.get("plugins:delete")!(undefined, first.installationId)) as {
        success: boolean
      }
      assert.equal(removed.success, true)
      assert.equal(getPlugins().length, 0)
      assert.equal(readFileSync(join(firstPath, "mods/main.ts"), "utf8"), original)
      assert.equal(service.list(scope()).installations[0].currentVersionId, undefined)
      console.log(
        "PASS real creator install: Worker -> index -> explicit grant -> utility command; live prepare, busy refusal, update, rollback and explicit uncertain-outcome reconciliation"
      )
    } finally {
      functions.close()
      manager.close()
    }
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
