import fs from "node:fs"
import path from "node:path"
import http from "node:http"
import { randomUUID } from "node:crypto"
import type { DesignTemplatePackage } from "../../../shared/design-template"

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".wasm": "application/wasm"
}

/** Token-scoped loopback server: no app preload, directory listings, writes or arbitrary file reads. */
export class DesignTemplatePreview {
  private server?: http.Server
  private starting?: Promise<number>
  private packages = new Map<string, { rootDir: string; files: Set<string> }>()
  private tokens = new Map<string, string>()

  async url(template: DesignTemplatePackage): Promise<string> {
    const port = await this.listen()
    let token = this.tokens.get(template.id)
    if (!token) {
      token = randomUUID()
      this.tokens.set(template.id, token)
    }
    this.packages.set(token, { rootDir: template.rootDir, files: new Set(template.files) })
    return `http://127.0.0.1:${port}/${token}/${template.entryPath.split("/").map(encodeURIComponent).join("/")}`
  }

  private listen(): Promise<number> {
    if (this.starting) return this.starting
    this.starting = new Promise<number>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        const address = server.address()
        if (
          !address ||
          typeof address === "string" ||
          request.headers.host !== `127.0.0.1:${address.port}`
        ) {
          response.writeHead(403).end()
          return
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405).end()
          return
        }
        try {
          const pathname = decodeURIComponent((request.url ?? "").split("?")[0])
          const [, token, ...segments] = pathname.split("/")
          const registration = this.packages.get(token)
          const relative = segments.join("/")
          if (
            !registration ||
            !registration.files.has(relative) ||
            segments.some(
              (part) =>
                !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0")
            )
          ) {
            response.writeHead(404).end()
            return
          }
          const root = fs.realpathSync(registration.rootDir)
          const file = fs.realpathSync(path.join(root, relative))
          const resolved = path.relative(root, file)
          if (
            resolved.startsWith(`..${path.sep}`) ||
            resolved === ".." ||
            path.isAbsolute(resolved) ||
            !fs.statSync(file).isFile()
          ) {
            response.writeHead(404).end()
            return
          }
          response.writeHead(200, {
            "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
            "content-length": fs.statSync(file).size,
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "content-security-policy": "sandbox allow-scripts allow-forms allow-modals"
          })
          if (request.method === "HEAD") response.end()
          else
            fs.createReadStream(file)
              .on("error", () => response.destroy())
              .pipe(response)
        } catch {
          response.writeHead(404).end()
        }
      })
      this.server = server
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.unref()
        const address = server.address()
        if (address && typeof address !== "string") resolve(address.port)
        else reject(new Error("无法启动模板预览"))
      })
    }).catch((error) => {
      this.starting = undefined
      throw error
    })
    return this.starting
  }

  close(): void {
    this.server?.closeAllConnections()
    this.server?.close()
    this.server = undefined
    this.starting = undefined
    this.packages.clear()
    this.tokens.clear()
  }
}
