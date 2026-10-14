export type CounterValue = number

declare module "claude-code" {
  interface PluginState {
    "typed-counter": { count: CounterValue }
  }
}
