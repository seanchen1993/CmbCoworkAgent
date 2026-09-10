/*
 * 浏览器录制所使用的 Playwright 源码统一入口。
 *
 * 这里仅导出 locator 生成与选择器解析相关的 Playwright 源码副本。
 * 录制器注入脚本生成物单独放在 generatedRecorderSources.ts 中，
 * 避免浏览器侧只使用 locator 功能时顺带加载录制器模块。
 */

export * from "./cssParser"
export * from "./cssTokenizer"
export * from "./locatorGenerators"
export * from "./selectorParser"
export * from "./stringUtils"
