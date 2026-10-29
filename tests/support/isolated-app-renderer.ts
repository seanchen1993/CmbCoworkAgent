import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createServer as reservePort } from "node:net"
import { dirname, join, resolve } from "node:path"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { build, preview } from "vite"

/** Actual production renderer with explicit fixture backends, without .env or out/ changes. */
export async function startIsolatedAppRenderer(root: string, isolated: string) {
  const reservation = reservePort()
  await new Promise<void>((done, fail) => {
    reservation.once("error", fail)
    reservation.listen(0, "127.0.0.1", done)
  })
  const reserved = reservation.address()
  assert(reserved && typeof reserved !== "string")
  await new Promise<void>((done, fail) =>
    reservation.close((error) => (error ? fail(error) : done()))
  )
  const origin = `http://127.0.0.1:${reserved.port}`
  const rendererRoot = join(root, "src/renderer")
  const output = resolve(isolated, "renderer")
  assert.equal(dirname(output), resolve(isolated), "Renderer output stays in its isolated fixture")
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version
  // Production mode keeps the real remote failure behavior: market's DEV-only fallback is off.
  // envPrefix=[] also excludes inherited VITE_* process values from this compilation.
  await build({
    configFile: false,
    envDir: false,
    envPrefix: [],
    mode: "production",
    root: rendererRoot,
    cacheDir: join(isolated, "vite-cache"),
    define: {
      __APP_VERSION__: JSON.stringify(version),
      "import.meta.env.VITE_API_BASE_URL": JSON.stringify(origin),
      "import.meta.env.VITE_OPEN_ASSISTANT_HUB_GATEWAY_URL": JSON.stringify(origin),
      "import.meta.env.VITE_LOGIN_INFO_ENDPOINT": JSON.stringify(`${origin}/cowork/login-info`),
      "import.meta.env.VITE_ZZJ_WEB_URL": JSON.stringify(origin)
    },
    resolve: {
      alias: {
        "@": join(root, "src/renderer/src"),
        "@renderer": join(root, "src/renderer/src")
      }
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "assert-isolated-production-renderer",
        configResolved(config) {
          assert.equal(config.isProduction, true)
          assert.equal(config.envDir, false)
          assert.deepEqual(
            Object.keys(config.env).filter((key) => key.startsWith("VITE_")),
            []
          )
        }
      }
    ],
    build: { outDir: output, emptyOutDir: false },
    logLevel: "warn"
  })
  const server = await preview({
    configFile: false,
    envDir: false,
    envPrefix: [],
    mode: "production",
    root: rendererRoot,
    build: { outDir: output },
    preview: { host: "127.0.0.1", port: reserved.port, strictPort: true },
    logLevel: "warn"
  })
  try {
    const address = server.httpServer.address()
    assert(address && typeof address !== "string" && address.port === reserved.port)
    return { url: `${origin}/`, backendOrigin: origin, output, close: () => server.close() }
  } catch (error) {
    await server.close()
    throw error
  }
}
