const http = require("node:http")
const fs = require("node:fs/promises")
const path = require("node:path")

const orders = [
  ["DEMO-001", "星野设计工作室", "SKU-100", "桌面收纳套装", 1, 12900, "paid"],
  ["DEMO-002", "林间咖啡", "SKU-101", "陶瓷马克杯", 4, 23600, "shipped"],
  ["DEMO-003", "南风书店", "SKU-102", "阅读台灯", 2, 39800, "pending"],
  ["DEMO-004", "周末生活馆", "SKU-100", "桌面收纳套装", 3, 38700, "paid"],
  ["DEMO-005", "山海文创", "SKU-103", "帆布手提袋", 10, 49000, "cancelled"],
  ["DEMO-006", "蓝鲸科技", "SKU-101", "陶瓷马克杯", 6, 35400, "shipped"],
  ["DEMO-007", "东岸空间", "SKU-102", "阅读台灯", 1, 19900, "pending"],
  ["DEMO-008", "晴日花房", "SKU-103", "帆布手提袋", 2, 9800, "paid"]
].map(([id, customer, sku, product, quantity, totalAmountCents, status], index) => ({
  id,
  customer,
  sku,
  product,
  quantity,
  totalAmountCents,
  status,
  currency: "CNY",
  createdAt: "2026-11-0" + (6 - Math.floor(index / 2)) + "T02:15:00Z"
}))
const statuses = [
  { value: "pending", label: "待支付" },
  { value: "paid", label: "已支付" },
  { value: "shipped", label: "已发货" },
  { value: "cancelled", label: "已取消" }
]
const stock = [
  { sku: "SKU-100", name: "桌面收纳套装", availableStock: 28, reservedStock: 4 },
  { sku: "SKU-101", name: "陶瓷马克杯", availableStock: 106, reservedStock: 10 },
  { sku: "SKU-102", name: "阅读台灯", availableStock: 3, reservedStock: 2 },
  { sku: "SKU-103", name: "帆布手提袋", availableStock: 67, reservedStock: 0 }
]
const assets = new Map([
  ["/health", ["package.json", "application/json"]],
  ["/", ["public/index.html", "text/html"]],
  ["/orders", ["public/index.html", "text/html"]],
  ["/style.css", ["public/style.css", "text/css"]],
  ["/vendor/vue.global.prod.js", ["public/vendor/vue.global.prod.js", "text/javascript"]],
  ["/api-docs", ["docs/api-challenge.txt", "text/plain"]],
  ["/api-docs-correct", ["docs/api-correct.txt", "text/plain"]]
])
// Models may extract helper modules in src/. Serve those without exposing the
// repository or following a symlink outside its source tree.
const sourceTypes = new Map([
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".css", "text/css"],
  [".json", "application/json"]
])
const contained = (root, file) => {
  const relative = path.relative(root, file)
  return (
    relative &&
    !relative.startsWith(".." + path.sep) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  )
}
async function readSource(route) {
  try {
    const name = decodeURIComponent(route.slice("/src/".length))
    const parts = name.split("/")
    const type = sourceTypes.get(path.extname(name))
    if (!type || /[\\\0:]/.test(name) || parts.some((part) => !part || part.startsWith(".")))
      return null
    const project = await fs.realpath(__dirname)
    const root = await fs.realpath(path.join(project, "src"))
    const file = await fs.realpath(path.resolve(root, ...parts))
    if (!contained(project, root) || !contained(root, file)) return null
    return { bytes: await fs.readFile(file), type }
  } catch {
    return null
  }
}
function createDemoServer() {
  return http.createServer(async (request, response) => {
    const json = (code, data) => {
      response.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      })
      response.end(JSON.stringify(data))
    }
    try {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET")
        return json(405, { code: "METHOD_NOT_ALLOWED", message: "演示服务仅提供 GET 读取接口" })
      }
      const url = new URL(request.url, "http://127.0.0.1")
      const route = url.pathname
      if (route.startsWith("/src/")) {
        const asset = await readSource(route)
        if (!asset) return json(404, { code: "NOT_FOUND", message: "源码资源不存在" })
        response.writeHead(200, {
          "Content-Type": asset.type + "; charset=utf-8",
          "Cache-Control": "no-store"
        })
        return response.end(asset.bytes)
      }
      if (assets.has(route)) {
        const [file, type] = assets.get(route)
        const bytes = await fs.readFile(path.join(__dirname, file))
        response.writeHead(200, {
          "Content-Type": type + "; charset=utf-8",
          "Cache-Control": "no-store"
        })
        return response.end(bytes)
      }
      if (route === "/api/session")
        return json(200, { user: { name: "陈晓", role: "运营主管" }, workspace: "青禾商贸" })
      if (route === "/api/overview")
        return json(200, {
          revenueCents: 982450,
          orderCount: 128,
          pendingShipment: 12,
          conversionRate: 0.126
        })
      if (route === "/api/order-statuses") return json(200, { statuses })
      if (route === "/api/warehouses")
        return json(200, {
          warehouses: [
            { id: "east", name: "华东仓" },
            { id: "south", name: "华南仓" }
          ]
        })
      if (route === "/api/orders") {
        const rawPage = Number(url.searchParams.get("page") ?? 1)
        const pageSize = Number(url.searchParams.get("pageSize") ?? 3)
        if (
          !Number.isSafeInteger(rawPage) ||
          rawPage < 1 ||
          !Number.isSafeInteger(pageSize) ||
          pageSize < 1 ||
          pageSize > 20
        )
          return json(400, {
            code: "INVALID_QUERY",
            message: "page 必须为正整数，pageSize 为 1 至 20"
          })
        const page = Math.max(1, rawPage)
        const q = (url.searchParams.get("q") ?? "").trim().toLowerCase()
        const status = url.searchParams.get("status") ?? ""
        if (status && !statuses.some((item) => item.value === status))
          return json(400, { code: "INVALID_STATUS", message: "未知订单状态：" + status })
        const selected = orders.filter(
          (order) =>
            (!status || order.status === status) &&
            (!q ||
              [order.id, order.customer, order.product].some((value) =>
                value.toLowerCase().includes(q)
              ))
        )
        return json(200, {
          orders: selected.slice((page - 1) * pageSize, page * pageSize),
          page,
          pageSize,
          total: selected.length
        })
      }
      if (/^\/api\/orders\/[^/]+$/.test(route)) {
        const order = orders.find((item) => item.id === route.split("/").pop())
        if (!order) return json(404, { code: "ORDER_NOT_FOUND", message: "订单不存在" })
        return json(200, {
          order: {
            ...order,
            shippingAddress: "上海市 · 演示路 88 号（虚构地址）",
            contact: "演示客户",
            items: [
              {
                sku: order.sku,
                name: order.product,
                quantity: order.quantity,
                unitPriceCents: order.totalAmountCents / order.quantity
              }
            ]
          }
        })
      }
      if (route === "/api/inventory") {
        const warehouse = url.searchParams.get("warehouse") ?? "east"
        if (!["east", "south"].includes(warehouse))
          return json(400, { code: "INVALID_WAREHOUSE", message: "仓库不存在" })
        return json(200, {
          warehouse,
          items: stock.map((row) => ({
            ...row,
            availableStock: warehouse === "east" ? row.availableStock : row.availableStock + 12
          }))
        })
      }
      if (route === "/api/trends")
        return json(200, {
          days: 7,
          points: [14200, 21900, 18700, 32600, 28400, 38900, 41600].map((revenueCents, index) => ({
            day: index === 0 ? "2026-10-31" : "2026-11-" + String(index).padStart(2, "0"),
            revenueCents
          }))
        })
      if (route === "/api/notifications") {
        response.setHeader("Retry-After", "30")
        return json(503, {
          code: "NOTIFICATION_UNAVAILABLE",
          message: "通知服务暂时不可用，请稍后重试",
          retryable: true
        })
      }
      return json(404, { code: "NOT_FOUND", message: "接口或页面不存在" })
    } catch {
      if (!response.headersSent) json(500, { code: "DEMO_ERROR", message: "演示资源读取失败" })
      else response.end()
    }
  })
}
module.exports = { createDemoServer }
if (require.main === module) {
  const port = Number(process.env.WORKBENCH_DEMO_PORT ?? 4179)
  const server = createDemoServer()
  server.on("error", (error) => {
    console.error(
      error.code === "EADDRINUSE"
        ? "Port " + port + " is already in use. Close the previous demo first."
        : error.message
    )
    process.exitCode = 1
  })
  server.listen(port, "127.0.0.1", () => {
    const base = "http://127.0.0.1:" + server.address().port
    console.log("Frontend API starter (unfinished source): " + base + "/")
    console.log("Vue page: " + base + "/orders")
    console.log("API document: " + base + "/api-docs-correct")
    console.log("Keep this window open. Press Ctrl+C to stop.")
  })
}
