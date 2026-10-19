import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type {
  CompositionExecutionContext,
  CompositionInputVerificationPhase
} from "./composition-coordinator"
import { ProjectCompositionStore } from "./composition-store"
import {
  readRuntimeScopedFile,
  runtimeDigest,
  runtimeDirectory,
  runtimeRelativePath
} from "./safe-files"

/** Original engine state stays in owned unit roots. Only explicit verified artifacts cross roots. */
export class CompositionWorkspaces {
  private readonly root: string
  constructor(
    root: string,
    private readonly store: ProjectCompositionStore,
    private readonly inputPath?: (context: CompositionExecutionContext, inputId: string) => string
  ) {
    mkdirSync(root, { recursive: true })
    this.root = runtimeDirectory(root)
  }
  locate(context: CompositionExecutionContext): CompositionExecutionContext {
    const workspace = this.store.unitWorkspace(context.runId, context.unit.id)
    if (!workspace) throw Error("COMPOSITION_EXECUTION_WORKSPACE_MISSING")
    return { ...context, inputs: this.mappedInputs(context), executionWorkspace: workspace }
  }
  prepare(context: CompositionExecutionContext): CompositionExecutionContext {
    const workspace = this.allocate(context.runId, context.unit.id)
    const copied = new Map<string, string>()
    const inputs = this.mappedInputs(context)
    for (const input of inputs) {
      const source = this.store.unitWorkspace(context.runId, input.fromUnitId)
      if (!source) throw Error("COMPOSITION_HANDOFF_WORKSPACE_MISSING")
      const file = readRuntimeScopedFile(source, input.artifact.path)
      if (!file.bytes || runtimeDigest(file.bytes) !== input.artifact.digest)
        throw Error("COMPOSITION_INPUTS_CHANGED")
      const key = input.destinationPath.toLowerCase()
      if (copied.has(key) && copied.get(key) !== input.artifact.digest)
        throw Error("COMPOSITION_INPUT_PATH_CONFLICT")
      copied.set(key, input.artifact.digest)
      const prior = readRuntimeScopedFile(workspace, input.destinationPath)
      if (prior.bytes) {
        if (runtimeDigest(prior.bytes) !== input.artifact.digest)
          throw Error("COMPOSITION_INPUT_PATH_CONFLICT")
        continue
      }
      let directory = workspace
      for (const part of runtimeRelativePath(input.destinationPath).split("/").slice(0, -1)) {
        directory = join(directory, part)
        mkdirSync(directory, { recursive: true })
        runtimeDirectory(directory)
      }
      const fd = openSync(join(workspace, input.destinationPath), "wx", 0o600)
      try {
        writeFileSync(fd, file.bytes)
      } finally {
        closeSync(fd)
      }
      const observed = readRuntimeScopedFile(workspace, input.destinationPath)
      if (!observed.bytes || runtimeDigest(observed.bytes) !== input.artifact.digest)
        throw Error("COMPOSITION_INPUTS_CHANGED")
    }
    return { ...context, inputs: this.mappedInputs(context), executionWorkspace: workspace }
  }
  /** Allocation is preparation only; upstream artifacts remain untouched until actual execution. */
  allocate(runId: string, unitId: string): string {
    runtimeRelativePath(runId)
    runtimeRelativePath(unitId)
    const workspace = join(this.root, runId, unitId)
    mkdirSync(workspace, { recursive: true })
    runtimeDirectory(workspace)
    this.store.registerUnitWorkspace(runId, unitId, workspace)
    return workspace
  }
  private mappedInputs(context: CompositionExecutionContext) {
    return context.inputs.map((input) => ({
      ...input,
      destinationPath: runtimeRelativePath(
        this.inputPath ? this.inputPath(context, input.inputId) : input.artifact.path
      )
    }))
  }
  verifyInputs(
    context: CompositionExecutionContext,
    phase: CompositionInputVerificationPhase = "prepared"
  ): boolean {
    const consumer = this.store.unitWorkspace(context.runId, context.unit.id)
    const outputPaths = new Set(context.unit.outputs.map((output) => output.path.toLowerCase()))
    return this.mappedInputs(context).every((input) => {
      const workspace = this.store.unitWorkspace(context.runId, input.fromUnitId)
      if (!workspace) return false
      const observed = readRuntimeScopedFile(workspace, input.artifact.path)
      if (!observed.bytes || runtimeDigest(observed.bytes) !== input.artifact.digest) return false
      // Configuration can allocate the consumer root before its handoff is materialized. Only
      // initial execution may defer a truly absent copy to prepare(), never a conflicting copy.
      if (!consumer) return phase === "before-prepare"
      if (phase === "before-prepare") {
        const copied = readRuntimeScopedFile(consumer, input.destinationPath)
        return !copied.present ||
          (!!copied.bytes && runtimeDigest(copied.bytes) === input.artifact.digest)
      }
      // A declared output may intentionally revise its starting input. Input-only copies remain
      // pinned to the producer's proven bytes throughout every consumer Skill and action.
      if (outputPaths.has(input.destinationPath.toLowerCase())) return true
      const copied = readRuntimeScopedFile(consumer, input.destinationPath)
      return !!copied.bytes && runtimeDigest(copied.bytes) === input.artifact.digest
    })
  }
  assertInputsCurrent(context: CompositionExecutionContext): void {
    if (!this.verifyInputs(context)) throw Error("COMPOSITION_INPUTS_CHANGED")
  }
}
