import type { CodeExecRequest, CodeExecResult, CodeExecRunner } from "./types"

export class CodeExecEngine {
  constructor(private readonly runner: CodeExecRunner) {}

  async execute(request: CodeExecRequest): Promise<CodeExecResult> {
    return this.runner.run({ request })
  }
}
