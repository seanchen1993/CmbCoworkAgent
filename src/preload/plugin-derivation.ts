import type { PluginDerivationApi } from "../shared/plugin-derivation"

export function createPluginDerivationBridge(
  invoke: (channel: string, input: unknown) => Promise<unknown>
): PluginDerivationApi {
  const call =
    <K extends keyof PluginDerivationApi>(_method: K, channel: string) =>
    (input: Parameters<PluginDerivationApi[K]>[0]) =>
      invoke(`plugins:derivation:${channel}`, input) as ReturnType<PluginDerivationApi[K]>
  return {
    revise: call("revise", "revise"),
    inspectUpstream: call("inspectUpstream", "inspect-upstream"),
    prepareNodeComposition: call("prepareNodeComposition", "prepare-node-composition"),
    prepareFlowComposition: call("prepareFlowComposition", "prepare-flow-composition"),
    propose: call("propose", "propose"),
    applyProposal: call("applyProposal", "apply-proposal"),
    cancelProposal: call("cancelProposal", "cancel-proposal"),
    sources: call("sources", "sources"),
    inspect: call("inspect", "inspect"),
    create: call("create", "create"),
    list: call("list", "list"),
    get: call("get", "get"),
    saveNotes: call("saveNotes", "save-notes"),
    check: call("check", "check"),
    listEditableFiles: call("listEditableFiles", "list-editable-files"),
    readFile: call("readFile", "read-file"),
    saveFile: call("saveFile", "save-file"),
    install: call("install", "install"),
    openSource: call("openSource", "open-source")
  }
}
