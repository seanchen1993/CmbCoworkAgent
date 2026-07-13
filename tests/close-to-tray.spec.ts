import assert from "assert"
import { readFileSync } from "fs"
import { resolve } from "path"
import {
  reduceCloseToTrayPrompt,
  type CloseToTrayPromptOpenEvent
} from "../src/shared/close-to-tray.ts"

const first: CloseToTrayPromptOpenEvent = {
  type: "open",
  requestId: 1,
  trayAreaName: "系统托盘"
}

assert.equal(reduceCloseToTrayPrompt(null, first), first)
assert.equal(
  reduceCloseToTrayPrompt(first, { type: "dismiss", requestId: 2, reason: "timeout" }),
  first,
  "a stale dismiss event must not close a newer prompt"
)
assert.equal(
  reduceCloseToTrayPrompt(first, { type: "dismiss", requestId: 1, reason: "timeout" }),
  null,
  "the matching timeout event must close the active prompt"
)

const rendererMain = readFileSync(resolve(__dirname, "../src/renderer/src/main.tsx"), "utf8")
const app = readFileSync(resolve(__dirname, "../src/renderer/src/App.tsx"), "utf8")
const dialog = readFileSync(
  resolve(__dirname, "../src/renderer/src/components/app/CloseToTrayDialog.tsx"),
  "utf8"
)
assert.equal(
  rendererMain.match(/<CloseToTrayDialog\s*\/>/g)?.length,
  1,
  "the prompt listener should have one process-lifetime mount"
)
assert.equal(
  app.includes("CloseToTrayDialog"),
  false,
  "conditional App branches must not mount independent prompt listeners"
)
assert.equal(
  /return\s*\(\)\s*=>[\s\S]{0,300}respondCloseToTrayPrompt/.test(dialog),
  false,
  "listener cleanup must not synthesize a cancel response"
)

console.log("close-to-tray.spec.ts passed")
