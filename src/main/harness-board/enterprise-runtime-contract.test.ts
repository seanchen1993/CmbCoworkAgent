import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS,
  HARNESS_ENTERPRISE_DETAIL_MAX_RESPONSE_BYTES,
  HARNESS_ENTERPRISE_PROJECTION_MAX_OUTPUT_BYTES,
  HARNESS_ENTERPRISE_REVIEW_MAX_ITEMS,
  HARNESS_ENTERPRISE_REVIEW_PAGE_SIZE,
  HARNESS_ENTERPRISE_REVIEW_SUMMARY_MAX_RESPONSE_BYTES,
  HARNESS_ENTERPRISE_REVIEW_TYPES_MAX_RESPONSE_BYTES
} from "./enterprise-projection-protocol"

const enterpriseSource = readFileSync(new URL("./enterprise-projects.ts", import.meta.url), "utf8")
const ipcSource = readFileSync(new URL("../ipc/harness-board.ts", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n"
)
const boardSource = readFileSync(
  new URL("../../renderer/src/components/harness-board/HarnessBoardView.tsx", import.meta.url),
  "utf8"
)
const mainSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8")

function section(source: string, start: string, end?: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe("Harness enterprise runtime isolation contract", () => {
  it("keeps project detail and review JSON parsing out of Electron main", () => {
    const details = section(
      enterpriseSource,
      "export async function getEnterpriseProjectDetails(",
      "export async function getProjectReviews("
    )
    const reviews = section(enterpriseSource, "export async function getProjectReviews(")
    for (const requestPath of [details, reviews]) {
      expect(requestPath).toContain("readBoundedResponseBody(")
      expect(requestPath).toContain("InWorker(")
      expect(requestPath).not.toContain("response.json(")
      expect(requestPath).not.toContain("JSON.parse(")
    }
  })

  it("enforces hard request, response, output, page, and item budgets", () => {
    expect(HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS).toBe(64)
    expect(HARNESS_ENTERPRISE_DETAIL_MAX_RESPONSE_BYTES).toBe(2 * 1024 * 1024)
    expect(HARNESS_ENTERPRISE_REVIEW_SUMMARY_MAX_RESPONSE_BYTES).toBe(2 * 1024 * 1024)
    expect(HARNESS_ENTERPRISE_REVIEW_TYPES_MAX_RESPONSE_BYTES).toBe(1024 * 1024)
    expect(HARNESS_ENTERPRISE_PROJECTION_MAX_OUTPUT_BYTES).toBe(512 * 1024)
    expect(HARNESS_ENTERPRISE_REVIEW_PAGE_SIZE).toBe(50)
    expect(HARNESS_ENTERPRISE_REVIEW_MAX_ITEMS).toBe(50)
  })

  it("uses independent sender lanes and cancels them on effect or board cleanup", () => {
    expect(ipcSource).toContain("harness-enterprise:${senderId}:${lane}")
    expect(ipcSource).toContain('"board-batch", "selected-project", "reviews"')
    expect(ipcSource).toContain('ipcMain.handle(\n    "harnessBoard:cancelEnterpriseRequests"')
    expect(boardSource).toContain('requestScope: "board-batch"')
    expect(boardSource).toContain('requestScope: "selected-project"')
    expect(boardSource).toContain('cancelEnterpriseRequests("board-batch")')
    expect(boardSource).toContain('cancelEnterpriseRequests("selected-project")')
    expect(boardSource).toContain('cancelEnterpriseRequests("reviews")')
    expect(boardSource).toContain("ENTERPRISE_PROJECT_DETAIL_QUERY_BATCH_SIZE = 32")
  })

  it("closes the enterprise projection worker during main-process shutdown", () => {
    expect(mainSource).toContain("closeHarnessEnterpriseProjectionWorker")
    expect(mainSource).toContain("closeHarnessEnterpriseProjectionWorker().catch")
  })
})
