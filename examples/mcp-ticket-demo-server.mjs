#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import * as z from "zod/v4"

const server = new McpServer({
  name: "cmb-ticket-demo-mcp",
  version: "1.0.0"
})

const OWNERS = ["张三", "李四", "王五", "赵六", "钱七"]
const STATUSES = ["open", "pending", "in_progress", "resolved"]
const TITLES = [
  "登录失败",
  "支付回调延迟",
  "报表导出超时",
  "审批流卡住",
  "权限同步异常",
  "消息通知重复",
  "客户画像加载慢",
  "发票识别失败"
]

function makeLongText(seed, repeat) {
  const paragraph =
    `这是工单 ${seed} 的长正文，用来模拟真实业务系统里很占上下文的描述、排查记录、日志片段和沟通历史。` +
    "如果没有裁剪，这些字段会随着列表一起塞给模型。"
  return Array.from({ length: repeat }, (_, index) => `${index + 1}. ${paragraph}`).join("\n")
}

function makeTicket(index) {
  const id = `INC-${String(1000 + index).padStart(4, "0")}`
  const status = STATUSES[index % STATUSES.length]
  return {
    id,
    title: TITLES[index % TITLES.length],
    status,
    owner: OWNERS[index % OWNERS.length],
    priority: index % 5 === 0 ? "P1" : index % 3 === 0 ? "P2" : "P3",
    updatedAt: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T09:${String(index % 60).padStart(2, "0")}:00+08:00`,
    description: makeLongText(id, 18),
    comments: Array.from({ length: 8 }, (_, commentIndex) => ({
      author: OWNERS[(index + commentIndex) % OWNERS.length],
      text: makeLongText(`${id}-COMMENT-${commentIndex + 1}`, 4),
      createdAt: `2026-07-${String((commentIndex % 28) + 1).padStart(2, "0")}T11:00:00+08:00`
    })),
    attachments: Array.from({ length: 4 }, (_, attachmentIndex) => ({
      name: `${id}-log-${attachmentIndex + 1}.txt`,
      sizeBytes: 120_000 + attachmentIndex * 8_192,
      preview: makeLongText(`${id}-ATTACHMENT-${attachmentIndex + 1}`, 5)
    }))
  }
}

const ALL_TICKETS = Array.from({ length: 60 }, (_, index) => makeTicket(index + 1))

const ticketOutputShape = {
  id: z.string(),
  title: z.string(),
  status: z.enum(["open", "pending", "in_progress", "resolved"]),
  owner: z.string(),
  priority: z.string(),
  updatedAt: z.string(),
  description: z.string(),
  comments: z.array(
    z.object({
      author: z.string(),
      text: z.string(),
      createdAt: z.string()
    })
  ),
  attachments: z.array(
    z.object({
      name: z.string(),
      sizeBytes: z.number(),
      preview: z.string()
    })
  )
}

server.registerTool(
  "ticket_list",
  {
    title: "Demo ticket list",
    description:
      "返回一批模拟工单列表。每条工单都包含很长的 description、comments、attachments，用来测试 invoke_deferred_tool 的 required_fields / max_array_items / max_result_chars 裁剪效果。",
    inputSchema: {
      status: z.enum(["not_closed", "open", "pending", "in_progress", "resolved", "all"]).default("not_closed"),
      limit: z.number().int().min(1).max(60).default(20)
    },
    outputSchema: {
      total: z.number(),
      items: z.array(z.object(ticketOutputShape))
    }
  },
  async ({ status = "not_closed", limit = 20 }) => {
    const filtered =
      status === "all"
        ? ALL_TICKETS
        : status === "not_closed"
          ? ALL_TICKETS.filter((ticket) => ticket.status !== "resolved")
          : ALL_TICKETS.filter((ticket) => ticket.status === status)

    const structuredContent = {
      total: filtered.length,
      items: filtered.slice(0, limit)
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent, null, 2)
        }
      ],
      structuredContent
    }
  }
)

server.registerTool(
  "ticket_detail",
  {
    title: "Demo ticket detail",
    description: "按工单 id 返回完整详情。用于测试先裁剪列表、再按 id 展开详情的两步工作流。",
    inputSchema: {
      id: z.string().describe("工单 ID，例如 INC-1001")
    },
    outputSchema: ticketOutputShape
  },
  async ({ id }) => {
    const structuredContent = ALL_TICKETS.find((ticket) => ticket.id === id)
    if (!structuredContent) {
      return {
        isError: true,
        content: [{ type: "text", text: `Ticket not found: ${id}` }]
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent, null, 2)
        }
      ],
      structuredContent
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error("cmb-ticket-demo-mcp running on stdio")
