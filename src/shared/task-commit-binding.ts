export function isValidTaskCommitCard(card: string): boolean {
  return (
    card.length > 0 &&
    card.length <= 256 &&
    !/[\s#]/u.test(card) &&
    !Array.from(card).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
}

export interface TaskCommitBinding {
  version: string
  workspacePath: string
  /** An empty card requires the user to select a card for each commit. */
  cardNumber: string
  repositoryPaths: string[]
}

export interface TaskCommitBindingEditor {
  token: string
  cardNumber: string
  repositories: string[]
  selected: string[]
  active: boolean
  warning?: string
}

export interface TaskCommitBindingApi {
  onChanged(callback: (threadId: string) => void): () => void
  read(threadId: string): Promise<TaskCommitBinding | null>
  open(threadId: string): Promise<TaskCommitBindingEditor>
  choose(token: string): Promise<string[]>
  save(token: string, cardNumber: string, repositories: string[]): Promise<TaskCommitBinding>
  revoke(token: string): Promise<void>
}
