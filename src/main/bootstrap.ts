// Keep both launch paths synchronous: Chromium switches must be configured before app.ready.
// The browser helper does not import application IPC, authentication, storage, or the Agent Runtime.
if (process.argv.includes("--cmb-bot-browser-host")) {
  require("./bot-browser-host.js")
} else {
  require("./application.js")
}
