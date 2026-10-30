import { createServer, type Server } from "node:http"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { existsSync } from "node:fs"
import { chromium, type Browser } from "playwright"
import { describe, expect, it } from "vitest"
import { ImageAssetStore, detectImageMime } from "./image-assets"
import { analyzeImages } from "./analyze-images"
import { projectMcpImageResult } from "./mcp-image-result"
import {
  normalizeMcpInvocationResult,
  toCallResult,
  toEagerToolResponse
} from "../mcp/result-utils"

interface RecordedImageBlock {
  type: string
  text?: string
  image_url?: { url: string }
}

// No model service or external web page is contacted. Chromium renders local
// SVG markup; only its rasterized PNG screenshot is sent to the local mock API.
describe("real browser screenshot to shared visual model", () => {
  it.skipIf(!existsSync("/usr/bin/chromium"))(
    "rasterizes SVG, preserves image IDs for follow-ups and sends ordered PNG bytes for multiple images",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "browser-vision-"))
      let browser: Browser | undefined
      let server: Server | undefined
      const requests: Array<{ messages: Array<{ role: string; content: RecordedImageBlock[] }> }> =
        []
      try {
        browser = await chromium.launch({
          executablePath: "/usr/bin/chromium",
          headless: true,
          args: ["--no-sandbox", "--disable-dev-shm-usage"]
        })
        const page = await browser.newPage({ viewport: { width: 320, height: 180 } })
        await page.setContent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="160">' +
            '<rect width="300" height="160" fill="white"/>' +
            '<circle cx="70" cy="80" r="40" fill="blue"/>' +
            '<text x="130" y="90" font-size="24">Screenshot A</text></svg>'
        )
        const firstPng = await page.screenshot({ type: "png" })
        await page.locator("circle").evaluate((circle) => circle.setAttribute("fill", "red"))
        const secondPng = await page.screenshot({ type: "png" })
        expect(firstPng.equals(secondPng)).toBe(false)
        expect(detectImageMime(firstPng)).toBe("image/png")
        expect(firstPng.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")

        const store = new ImageAssetStore(root)
        const mcpResult = normalizeMcpInvocationResult("browser_take_screenshot", {
          content: [
            { type: "image", data: firstPng.toString("base64"), mimeType: "image/png" },
            { type: "image", data: secondPng.toString("base64"), mimeType: "image/png" }
          ],
          structuredContent: { duplicateImage: firstPng.toString("base64") }
        })
        const safeResult = await projectMcpImageResult(
          "visual-thread",
          mcpResult,
          "browser_take_screenshot",
          store.projectContent.bind(store)
        )
        const references = safeResult.contentBlocks as Array<{ type: string; text: string }>
        expect(references.every((item) => item.type === "text")).toBe(true)
        const imageIds = references.map((item) => /image_id=(img_[a-f0-9]{64})/.exec(item.text)![1])
        expect(new Set(imageIds).size).toBe(2)
        expect(JSON.stringify(references)).not.toContain(firstPng.toString("base64"))
        // Both eager tools and the deferred/code_exec proxy see only references.
        expect(JSON.stringify(toEagerToolResponse(safeResult))).not.toContain(
          firstPng.toString("base64")
        )
        expect(JSON.stringify(toCallResult(safeResult))).toContain(imageIds[0])
        expect(JSON.stringify(toCallResult(safeResult))).not.toContain(firstPng.toString("base64"))
        expect((await store.register("visual-thread", firstPng, "follow-up screenshot")).id).toBe(
          imageIds[0]
        )

        server = createServer(async (request, response) => {
          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(chunk)
          requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
          response.setHeader("Content-Type", "text/event-stream")
          response.write(
            `data: ${JSON.stringify({
              id: "mock-visual-output",
              choices: [
                {
                  index: 0,
                  delta: { content: "Mock image evidence with sources" },
                  finish_reason: "stop"
                }
              ]
            })}\n\n`
          )
          response.end("data: [DONE]\n\n")
        })
        server.listen(0, "127.0.0.1")
        await once(server, "listening")
        const address = server.address()
        if (!address || typeof address === "string") throw new Error("Missing mock address")
        const model = {
          baseUrl: `http://127.0.0.1:${address.port}/llm/vision/v1`,
          model: "replaceable-vision",
          apiKey: "mock-key"
        }
        const comparison = await analyzeImages({
          model,
          images: await store.resolve("visual-thread", imageIds),
          question: "Compare the two screenshots"
        })
        expect(comparison.sources.map((source) => source.image_id)).toEqual(imageIds)
        expect(comparison.sources.map((source) => source.position)).toEqual([1, 2])

        // A reopened store and the old ID remain sufficient for a later turn.
        await analyzeImages({
          model,
          images: await new ImageAssetStore(root).resolve("visual-thread", [imageIds[0]]),
          question: "What color is the circle in the first image?"
        })
        expect(requests).toHaveLength(2)
        const sentFirst = requests[0].messages[1].content.filter(
          (block) => block.type === "image_url"
        )
        const sentFollowUp = requests[1].messages[1].content.filter(
          (block) => block.type === "image_url"
        )
        expect(sentFirst).toHaveLength(2)
        expect(sentFollowUp).toHaveLength(1)
        for (const [index, png] of [firstPng, secondPng].entries()) {
          const url = sentFirst[index].image_url!.url
          expect(url.startsWith("data:image/png;base64,")).toBe(true)
          const receivedBytes = Buffer.from(url.split(",", 2)[1], "base64")
          expect(receivedBytes).toEqual(png)
          expect(receivedBytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
          expect(receivedBytes.toString("utf8")).not.toContain("<svg")
        }
        expect(sentFollowUp[0].image_url!.url).toBe(sentFirst[0].image_url!.url)
      } finally {
        await browser?.close()
        if (server) {
          server.closeAllConnections()
          server.close()
          await once(server, "close")
        }
        await rm(root, { recursive: true, force: true })
      }
    },
    30_000
  )
})
