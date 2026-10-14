/** Native closure identity. Never serialized into FunctionInvocation or SDK arguments. */
export interface FunctionCapabilitySource {
  readonly event: string
  readonly registration: string
  readonly identity?: object
}
