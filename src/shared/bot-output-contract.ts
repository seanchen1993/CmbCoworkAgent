/** A human-authored delivery requirement. Models cannot add or weaken it. */
export type BotOutputFileContract =
  | { name: string; kind: "csv" | "tsv"; columns: string[] }
  | { name: string; kind: "json"; schema: Record<string, unknown> | boolean }
export interface BotOutputContract {
  files: BotOutputFileContract[]
}
