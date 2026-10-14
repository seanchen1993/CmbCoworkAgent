export const app = {
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getPath: () => process.env.CMB_COWORK_AGENT_HOME ?? process.cwd(),
  getName: () => "closed-flow-fixture",
  getVersion: () => "0",
  isReady: () => false,
  on: () => {},
  once: () => {}
}
export const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => undefined }
export const ipcMain = { handle: () => {}, on: () => {}, removeHandler: () => {} }
export const dialog = {}
export const shell = {}
export const screen = {}
export const nativeImage = {}
export const session = {}
export const clipboard = {}
export const webContents = {}
export const Notification = class {}
export const safeStorage = { isEncryptionAvailable: () => false }
export const utilityProcess = {
  fork: () => {
    throw Error("PROMPT_FIXTURE_UNEXPECTED_VM_STARTUP")
  }
}
