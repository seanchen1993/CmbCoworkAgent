// This is the small SDK surface used by this example, not a replacement host implementation.
export interface FunctionEvent {
  args?: unknown
  component?: string
  requestId?: string
}

type UiConstructor = (props: Record<string, unknown>) => unknown

export interface AutobizSdk {
  plugin: { root: string }
  session: { root(): Promise<string> }
  command: {
    register(command: {
      name: string
      description: string
      argumentHint?: string
      immediate?: boolean
      isHidden?: boolean
    }): Promise<unknown>
  }
  process: {
    run(
      argv: string[],
      init: { cwd: string; env: Record<string, string>; timeoutMs: number }
    ): Promise<unknown>
  }
  fs: { read(path: string): Promise<string> }
  model: {
    complete(request: {
      model: "default"
      prompt: string
      system: string
      maxTokens: number
    }): Promise<unknown>
  }
  ui: {
    open(props: {
      id: string
      title: string
      rows: number
      closeOnEscape: boolean
    }): Promise<unknown>
    invalidate(pattern: string): Promise<unknown>
    resolve(event: FunctionEvent): Record<"Box" | "Text" | "Select" | "Button", UiConstructor>
  }
}

export type RegisterFunction = (
  pattern: string,
  filter: Record<string, string>,
  handler: (
    sdk: AutobizSdk,
    event: FunctionEvent,
    next: (event: FunctionEvent) => Promise<unknown>
  ) => unknown
) => void
