export interface ProjectActionResults {
  projectId: string
  operationId: string
  packageVersion: string
  pluginDigest: string
  observedAt: number
  flowStatus: string | null
  message: string
  actions: Array<{
    id: string
    plugin: string
    actionId: string
    providerDigest: string
    authorizedNow: boolean
    status: string
    summary: string | null
    output: string | null
    inputSchema: string
    outputSchema: string
    truncated: boolean
  }>
}
