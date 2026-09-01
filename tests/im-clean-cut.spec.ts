import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(__dirname, "..")
const read = (path: string): string => readFileSync(join(root, path), "utf8")

for (const removedPath of [
  "src/main/services/chatx.ts",
  "src/main/services/chatx-stream-ids.ts",
  "src/main/ipc/chatx.ts",
  "src/renderer/src/components/customize/ChatXPanel.tsx"
]) {
  assert.equal(existsSync(join(root, removedPath)), false, `${removedPath} must stay deleted`)
}

const sourceFiles = readdirSync(join(root, "src"), { recursive: true })
  .map(String)
  .filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"))
const allSource = sourceFiles.map((path) => read(join("src", path))).join("\n")
for (const removedRuntimeToken of [
  "VITE_CHATX_WS_URL",
  "VITE_CHATX_HTTP_URL",
  "VITE_CHATX_CHANNEL",
  "VITE_CHATX_CALLBACK_URL",
  "window.api.chatx",
  "trySendChatXReply",
  "chatxRobotChatId"
]) {
  assert.equal(
    allSource.includes(removedRuntimeToken),
    false,
    `legacy runtime token ${removedRuntimeToken} must not return`
  )
}

const storage = read("src/main/storage.ts")
assert(storage.includes('"chatx-config.json"'), "legacy credential existence can be detected")
assert(
  storage.includes("remoteApprovalEnabled: true"),
  "remote tool approval must default to enabled for new settings"
)
assert(
  storage.includes('typeof value.remoteApprovalEnabled === "boolean"'),
  "an explicit remote approval preference must survive settings reload"
)
assert(
  !/readFileSync\(CHATX_CONFIG_FILE/.test(storage),
  "legacy credential content must never be read or migrated"
)
assert(
  storage.includes("if (confirmed !== true) throw new Error"),
  "legacy credentials require explicit deletion confirmation"
)

const panel = read("src/renderer/src/components/customize/BuiltinRobotPanel.tsx")
for (const forbiddenField of ["clientSecret", "toUserList", "workDir", "modelId", "callback URL"]) {
  assert.equal(
    panel.includes(forbiddenField),
    false,
    `built-in card must not expose ${forbiddenField}`
  )
}
assert(panel.includes("内置统一机器人"))
assert(panel.includes("接入招乎"))
assert(panel.includes("页面已打开，连接状态正在后台刷新"))
assert(panel.includes("loadStatus"))
assert(panel.includes("loadDetails"))
assert(
  !/Promise\.all\([\s\S]*builtinRobot\.getStatus\(\)/u.test(panel),
  "the first robot status paint must not wait for secondary data"
)
assert(panel.includes("默认开启。仅支持工作区内文件写入"))
assert(panel.includes("setThreadRemoteAccess"))
assert(panel.includes("setFeatureRemoteAccess"))
assert(!allSource.includes("请先在招乎中向内置机器人发送一条消息"))
assert(!panel.includes("inbox-and-features"), "global Feature access toggle is retired")
assert(panel.includes("同一用户只保留一个活动桌面连接"))
assert(!allSource.includes("deviceEpoch"), "device routing epochs must stay retired")
assert(!allSource.toLowerCase().includes("takeover"), "device takeover must stay retired")

const preload = read("src/preload/index.ts")
assert(preload.includes("builtinRobot:"))
assert(!preload.includes("chatx:"))
const main = read("src/main/index.ts")
assert(main.includes("builtinRobotManager.start(app.getVersion())"))
assert(main.includes("builtinRobotManager.stop()"))
const robotManager = read("src/main/services/im/manager.ts")
assert(
  /listGrantableFeatures\(\)[\s\S]*Promise\.all\([\s\S]*listRemoteFeatures/u.test(robotManager),
  "Feature details should load concurrently after the first robot paint"
)

const imContract = read("src/shared/im-gateway-contract.ts")
const mainTypes = read("src/main/types.ts")
const agentRuntime = read("src/main/agent/runtime.ts")
const imRunner = read("src/main/services/im/remote-runner.ts")
const chatContainer = read("src/renderer/src/components/chat/ChatContainer.tsx")

assert.equal(
  (allSource.match(/"zhaohu"/g) ?? []).length,
  2,
  "the concrete IM channel literal must stay confined to its shared type and default value"
)
assert(imContract.includes('export type ImChannelId = "zhaohu"'))
assert(imContract.includes("export const DEFAULT_IM_CHANNEL_ID: ImChannelId"))
assert(mainTypes.includes("provider: ImChannelId"))
assert(!agentRuntime.includes('"zhaohu"'), "the generic Agent Runtime cannot know a channel id")
assert(
  !agentRuntime.includes("const delivery = meta.imDeliveryContext"),
  "the generic Agent Runtime cannot infer transport context from Thread metadata"
)
assert(
  agentRuntime.includes("imDeliveryContext: options.imDeliveryContext ?? null"),
  "the generic Agent Runtime only forwards caller-owned scheduler delivery context"
)
assert(
  imRunner.includes("resolveImInboxDeliveryContextForRuntime({") &&
    imRunner.includes("context.provider !== DEFAULT_IM_CHANNEL_ID") &&
    imRunner.includes('typeof context.principalId !== "string"'),
  "the IM caller validates and supplies inbox scheduler delivery context"
)
assert(
  chatContainer.includes("context.provider !== DEFAULT_IM_CHANNEL_ID") &&
    !chatContainer.includes('"zhaohu"'),
  "the renderer uses the shared channel identifier"
)

console.log("im-clean-cut.spec.ts passed")
