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
assert(panel.includes("远程访问范围"))
assert(panel.includes("强制接管"))

const preload = read("src/preload/index.ts")
assert(preload.includes("builtinRobot:"))
assert(!preload.includes("chatx:"))
const main = read("src/main/index.ts")
assert(main.includes("builtinRobotManager.start(app.getVersion())"))
assert(main.includes("builtinRobotManager.stop()"))

console.log("im-clean-cut.spec.ts passed")
