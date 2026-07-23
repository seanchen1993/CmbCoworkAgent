import { spawn } from "node:child_process"

const port = process.env.CMB_BROWSER_CDP_PORT?.trim() || "9222"
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
  console.error("CMB_BROWSER_CDP_PORT must be an integer between 1 and 65535")
  process.exit(1)
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
const child = spawn(npmCommand, ["run", "dev"], {
  env: { ...process.env, CMB_BROWSER_CDP_PORT: port },
  stdio: "inherit"
})

async function reportCdpReadiness() {
  const endpoint = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(500)
      })
      if (response.ok) {
        console.log(`Playwright MCP PoC CDP endpoint ready: ${endpoint}`)
        return
      }
    } catch {
      // Electron may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  console.error(`Playwright MCP PoC CDP endpoint did not start: ${endpoint}`)
  console.error("Quit every running CMBDevClaw instance, then retry this command.")
}

void reportCdpReadiness()

child.on("error", (error) => {
  console.error(`Failed to start Playwright MCP PoC: ${error.message}`)
  process.exitCode = 1
})

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal))
}
