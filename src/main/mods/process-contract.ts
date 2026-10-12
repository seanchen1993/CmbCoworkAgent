/** The same Mods protocol can use Electron utilityProcess or a headless Node child. */
export interface ModProcess<Request, Response> {
  readonly pid?: number
  readonly stdout?: NodeJS.ReadableStream | null
  readonly stderr?: NodeJS.ReadableStream | null
  on(event: "message", listener: (message: Response) => void): this
  on(event: "exit", listener: (code: number | null) => void): this
  on(event: "error", listener: (error: Error) => void): this
  postMessage(message: Request): void
  kill(): void
}

export type ModProcessLauncher = <Request, Response>(
  entry: string,
  options: { env: Record<string, string>; serviceName: string }
) => ModProcess<Request, Response>

export interface ModParentPort<Request, Response> {
  on(event: "message", listener: (event: { data: Request }) => void): void
  postMessage(message: Response): void
}
