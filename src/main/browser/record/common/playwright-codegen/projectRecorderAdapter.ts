import {
  PLAYWRIGHT_GENERATED_INJECTED_SCRIPT_SOURCE,
  PLAYWRIGHT_GENERATED_POLLING_RECORDER_SOURCE
} from "./generatedRecorderSources"

// 项目适配器：对外暴露 Playwright 录制器源码副本，避免把 Electron 控制台桥接逻辑混入上游源码。
export interface PlaywrightRecorderSourceBundle {
  injectedScriptSource: string
  pollingRecorderSource: string
}

export function getPlaywrightRecorderSourceBundle(): PlaywrightRecorderSourceBundle {
  return {
    injectedScriptSource: PLAYWRIGHT_GENERATED_INJECTED_SCRIPT_SOURCE,
    pollingRecorderSource: PLAYWRIGHT_GENERATED_POLLING_RECORDER_SOURCE
  }
}
