import { randomUUID } from "node:crypto"
import { getRunningClientForWorkspace } from "../../lsp"
import type { LspClient } from "../../lsp/client"
import type {
  DeveloperCodeInput,
  DeveloperCodeMethod
} from "../../../shared/mods/v2/developer-code-capability"
import {
  createCodePlatformProvider,
  type CodeObservationClient,
  type CodePlatformDependencies
} from "./platform-code-provider"

const clients = new WeakMap<LspClient, CodeObservationClient>()

/** Only running original Java clients. This adapter owns neither server startup nor shutdown. */
export function createNativeCodePlatformProvider(
  dependencies: Pick<CodePlatformDependencies, "authorizePath">
) {
  return createCodePlatformProvider({
    ...dependencies,
    capture(workspace) {
      const client = getRunningClientForWorkspace(workspace)
      if (!client) return undefined
      let adapter = clients.get(client)
      if (!adapter) {
        adapter = {
          identity: randomUUID(),
          status: () => {
            const status = client.getStartupStatus()
            return {
              initialized: client.isReady(),
              serviceReady: status.serviceReady,
              projectReady: status.projectReady
            }
          },
          documentVersion: (path) => client.getObservedDocumentVersion(path),
          documentGeneration: () => client.getObservedDocumentGeneration(),
          openFile: (path, text) => client.openFile(path, text),
          async query(
            method: DeveloperCodeMethod,
            input: DeveloperCodeInput & { filePath?: string }
          ) {
            const path = input.filePath!,
              line = input.line!,
              column = input.column!
            switch (method) {
              case "definition":
                return client.definition(path, line, column)
              case "references":
                return client.references(path, line, column)
              case "hover":
                return client.hover(path, line, column)
              case "implementation":
                return client.implementation(path, line, column)
              case "documentSymbols":
                return client.documentSymbols(path)
              case "workspaceSymbol":
                return client.workspaceSymbol(input.query!)
              case "diagnostics":
                return client.getDiagnostics(input.filePath)
              case "prepareCallHierarchy":
                return client.prepareCallHierarchy(path, line, column)
              case "incomingCalls":
                return client.incomingCalls(path, line, column)
              case "outgoingCalls":
                return client.outgoingCalls(path, line, column)
            }
          }
        }
        clients.set(client, adapter)
      }
      return adapter
    }
  })
}
