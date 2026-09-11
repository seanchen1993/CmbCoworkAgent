/*
 * Playwright 生成的录制器源码副本。
 *
 * ./generated/ 下的 CommonJS 文件是从 playwright-core 原样复制的，
 * 用于复用 Playwright 的录制器运行时；项目逻辑不要混入这些源码副本。
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { source: injectedScriptSource } = require("./generated/injectedScriptSource.js") as {
  source: string
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { source: pollingRecorderSource } = require("./generated/pollingRecorderSource.js") as {
  source: string
}

export const PLAYWRIGHT_GENERATED_INJECTED_SCRIPT_SOURCE = injectedScriptSource
export const PLAYWRIGHT_GENERATED_POLLING_RECORDER_SOURCE = pollingRecorderSource
