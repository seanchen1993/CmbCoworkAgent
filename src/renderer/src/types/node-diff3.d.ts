// node-diff3 未自带类型声明。这里只声明本项目用到的子集。
// 参考：https://github.com/bhousel/node-diff3
declare module "node-diff3" {
  /** diffComm 输出：common 为两侧一致块；buffer1/buffer2 分别为 a/b 侧差异块。 */
  export interface CommChunk {
    common?: string[]
    buffer1?: string[]
    buffer2?: string[]
  }
  export function diffComm(a: string[], b: string[]): CommChunk[]

  export interface MergeRegionResult {
    conflict: boolean
    result: string[]
  }
  export interface MergeOptions {
    excludeFalseConflicts?: boolean
    stringSeparator?: string | RegExp
    label?: { a?: string; o?: string; b?: string }
  }
  /** 三方合并，输出 git 风格冲突标记（mergeDiff3 含 ||||||| 基线段）。 */
  export function mergeDiff3(
    a: string[],
    o: string[],
    b: string[],
    options?: MergeOptions
  ): MergeRegionResult
  export function merge(
    a: string[],
    o: string[],
    b: string[],
    options?: MergeOptions
  ): MergeRegionResult

  export type MergeRegion =
    | { ok: string[] }
    | { conflict: { a: string[]; aIndex: number; o: string[]; oIndex: number; b: string[]; bIndex: number } }
  export function diff3Merge(
    a: string[],
    o: string[],
    b: string[],
    options?: MergeOptions
  ): MergeRegion[]
}
