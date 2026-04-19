/**
 * Dashboard IPC Handlers
 *
 * Proxies Elasticsearch queries for the operations dashboard.
 * The renderer never connects to ES directly — all queries go through
 * these IPC handlers for security.
 */

import { ipcMain, dialog, BrowserWindow } from "electron"
import { getUserInfo } from "../storage"
import * as fs from "fs"

// ─────────────────────────────────────────────────────────
// ES Configuration (from .env)
// ─────────────────────────────────────────────────────────

function getEsNodes(): string[] {
  const raw = import.meta.env.VITE_ES_NODES as string | undefined
  if (!raw) return []
  return raw.split(",").map((n) => n.trim()).filter(Boolean)
}

function getEsAuth(): { username: string; password: string } | null {
  const username = import.meta.env.VITE_ES_USERNAME as string | undefined
  const password = import.meta.env.VITE_ES_PASSWORD as string | undefined
  if (!username || !password) return null
  return { username, password }
}

function getEsIndex(type: "trace" | "event"): string {
  if (type === "trace") return (import.meta.env.VITE_ES_INDEX_TRACE as string) || "devclaw_trace"
  return (import.meta.env.VITE_ES_INDEX_EVENT as string) || "devclaw_event"
}

const ALLOWED_YST_IDS_RAW = (import.meta.env.VITE_DASHBOARD_ALLOWED_YST_IDS as string) || ""
const ALLOWED_YST_IDS = new Set(
  ALLOWED_YST_IDS_RAW.split(",").map((s) => s.trim()).filter(Boolean)
)

// ─────────────────────────────────────────────────────────
// ES HTTP helper
// ─────────────────────────────────────────────────────────

let nodeIndex = 0

async function esQuery(index: string, body: Record<string, unknown>): Promise<unknown> {
  const nodes = getEsNodes()
  if (nodes.length === 0) throw new Error("ES_NODES not configured")

  const auth = getEsAuth()
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (auth) {
    headers["Authorization"] = "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64")
  }

  // Round-robin with fallback
  const startIdx = nodeIndex
  let lastError: Error | null = null

  for (let i = 0; i < nodes.length; i++) {
    const idx = (startIdx + i) % nodes.length
    const url = `${nodes[idx]}/${index}/_search`
    nodeIndex = (idx + 1) % nodes.length

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000)
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => "")
        throw new Error(`ES ${resp.status}: ${text.slice(0, 200)}`)
      }
      return await resp.json()
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      console.warn(`[Dashboard] ES node ${nodes[idx]} failed:`, lastError.message)
    }
  }

  throw lastError ?? new Error("All ES nodes failed")
}

// ─────────────────────────────────────────────────────────
// Query builders
// ─────────────────────────────────────────────────────────

interface TimeRange {
  from: string  // ISO string
  to: string    // ISO string
}

type Granularity = "day" | "week" | "month" | "custom"

const DISLIKE_TYPE_OPTIONS = [
  { id: "slow", label: "太慢了" },
  { id: "not_helpful", label: "内容不相关" },
  { id: "inaccurate", label: "信息不准确" },
  { id: "unclear", label: "表述不清楚" },
  { id: "unsafe", label: "包含不安全内容" },
  { id: "other", label: "其他原因" }
] as const

function getCalendarInterval(granularity: Granularity, from: string, to: string): string {
  if (granularity === "day") return "hour"
  if (granularity === "custom") {
    const diffMs = new Date(to).getTime() - new Date(from).getTime()
    const diffDays = diffMs / (1000 * 60 * 60 * 24)
    if (diffDays <= 1) return "hour"
    if (diffDays <= 14) return "day"
    return "week"
  }
  return "day" // week or month → bucket by day
}

function timeRangeFilter(field: string, range: TimeRange): Record<string, unknown> {
  return { range: { [field]: { gte: range.from, lte: range.to } } }
}

// ─────────────────────────────────────────────────────────
// Dashboard data fetchers
// ─────────────────────────────────────────────────────────

async function fetchOverview(range: TimeRange, granularity: Granularity): Promise<unknown> {
  const interval = getCalendarInterval(granularity, range.from, range.to)
  const body = {
    size: 0,
    query: { bool: { filter: [timeRangeFilter("startedAt", range)] } },
    aggs: {
      total_calls:        { value_count: { field: "traceId" } },
      active_users:       { cardinality: { field: "sapId" } },
      avg_duration:       { avg: { field: "durationMs" } },
      total_input_tokens: { sum: { field: "totalInputTokens" } },
      total_output_tokens:{ sum: { field: "totalOutputTokens" } },
      total_skills:       { cardinality: { field: "usedSkills" } },
      total_tools:        { cardinality: { field: "toolNames" } },
      total_skill_calls:  { value_count: { field: "usedSkills" } },
      total_tool_calls:   { value_count: { field: "toolNames" } },
      by_skill: { terms: { field: "usedSkills",  size: 10 } },
      by_tool: {
        terms: {
          field: "toolNames",
          size: 10,
          exclude: [
            // Claude Code 内置文件 / 系统工具
            "execute", "read_file", "write_file", "glob", "grep",
            "list_directory", "task", "task_output",
            "ls", "edit_file",
            // 工具搜索 / 元工具
            "search_tool", "inspect_tool", "invoke_deferred_tool",
            // 内置代码执行辅助
            "code_exec", "prepare_save_code_exec_tool", "save_code_exec_tool",
            // 内置任务管理
            "write_todos"
          ]
        }
      },
      by_tool_all: {
        terms: { field: "toolNames", size: 50 }
      },
      trend: {
        date_histogram: { field: "startedAt", calendar_interval: interval, time_zone: "Asia/Shanghai" },
        aggs: {
          users: { cardinality: { field: "sapId" } }
        }
      }
    }
  }
  return esQuery(getEsIndex("trace"), body)
}

async function fetchModelStats(range: TimeRange, granularity: Granularity): Promise<unknown> {
  void granularity
  const body = {
    size: 0,
    query: { bool: { filter: [timeRangeFilter("startedAt", range)] } },
    aggs: {
      by_model: {
        terms: { field: "modelName", size: 30 },
        aggs: {
          total_input_tokens:  { sum: { field: "totalInputTokens" } },
          total_output_tokens: { sum: { field: "totalOutputTokens" } }
        }
      },
      by_tier: {
        terms: { field: "routing.resolvedTier", size: 5 }
      },
      by_layer: {
        terms: { field: "routing.decidedByLayer", size: 10 }
      }
    }
  }
  return esQuery(getEsIndex("trace"), body)
}

async function fetchUserStats(range: TimeRange, granularity: Granularity): Promise<unknown> {
  void granularity
  const body = {
    size: 0,
    query: { bool: { filter: [timeRangeFilter("startedAt", range)] } },
    aggs: {
      top_users: {
        terms: { field: "sapId", size: 50 },
        aggs: {
          user_name: { terms: { field: "userName",  size: 1 } },
          org_name:  { terms: { field: "orgName",   size: 1 } }
        }
      },
      by_org:     { terms: { field: "orgName",     size: 30 } },
      by_version: {
        terms: { field: "appVersion", size: 20 },
        aggs: { unique_users: { cardinality: { field: "sapId" } } }
      }
    }
  }
  return esQuery(getEsIndex("trace"), body)
}

async function fetchProductivity(range: TimeRange, granularity: Granularity): Promise<unknown> {
  const interval = getCalendarInterval(granularity, range.from, range.to)
  const body = {
    size: 0,
    query: {
      bool: {
        filter: [
          timeRangeFilter("eventTime", range),
          { term: { "eventName": "git.commit.created" } }
        ]
      }
    },
    aggs: {
      commit_trend: {
        date_histogram: { field: "eventTime", calendar_interval: interval, time_zone: "Asia/Shanghai" }
      },
      total_insertions: { sum: { field: "properties.insertions" } },
      total_deletions: { sum: { field: "properties.deletions" } },
      total_files_changed: { sum: { field: "properties.filesChanged" } },
      active_users: { cardinality: { field: "sapId" } },
      total_commits: { value_count: { field: "eventId" } }
    }
  }
  return esQuery(getEsIndex("event"), body)
}

async function fetchFeedback(range: TimeRange, granularity: Granularity): Promise<unknown> {
  const interval = getCalendarInterval(granularity, range.from, range.to)
  const dislikeTypeFilters = Object.fromEntries(
    DISLIKE_TYPE_OPTIONS.map((item) => [
      item.id,
      {
        bool: {
          filter: [
            { term: { eventName: "message.feedback.dislike.submit" } },
            {
              bool: {
                should: [
                  { term: { "properties.dislikeType": item.id } },
                  { term: { "properties.feedbackId": item.id } }
                ],
                minimum_should_match: 1
              }
            }
          ]
        }
      }
    ])
  )

  const body = {
    size: 0,
    query: {
      bool: {
        filter: [
          timeRangeFilter("eventTime", range),
          {
            terms: {
              eventName: [
                "message.feedback.like",
                "message.feedback.dislike.submit"
              ]
            }
          }
        ]
      }
    },
    aggs: {
      total_likes: {
        filter: { term: { eventName: "message.feedback.like" } },
        aggs: {
          unique_users: { cardinality: { field: "sapId" } }
        }
      },
      total_dislikes: {
        filter: { term: { eventName: "message.feedback.dislike.submit" } },
        aggs: {
          unique_users: { cardinality: { field: "sapId" } }
        }
      },
      dislike_by_type: {
        filters: {
          filters: dislikeTypeFilters
        }
      },
      trend: {
        date_histogram: {
          field: "eventTime",
          calendar_interval: interval,
          time_zone: "Asia/Shanghai"
        },
        aggs: {
          likes: {
            filter: { term: { eventName: "message.feedback.like" } }
          },
          dislikes: {
            filter: { term: { eventName: "message.feedback.dislike.submit" } }
          }
        }
      },
      recent_dislike_comments: {
        filter: {
          bool: {
            filter: [
              { term: { eventName: "message.feedback.dislike.submit" } },
              { exists: { field: "properties.dislikeText" } }
            ]
          }
        },
        aggs: {
          latest: {
            top_hits: {
              size: 20,
              sort: [{ eventTime: { order: "desc" } }],
              _source: {
                includes: [
                  "eventTime",
                  "properties.dislikeType",
                  "properties.dislikeTypeLabel",
                  "properties.dislikeText"
                ]
              }
            }
          }
        }
      }
    }
  }

  return esQuery(getEsIndex("event"), body)
}

// ─────────────────────────────────────────────────────────
// Dev mock data
// ─────────────────────────────────────────────────────────

function makeMockOverview(range: TimeRange): unknown {
  const from = new Date(range.from)
  const to = new Date(range.to)
  const diffMs = to.getTime() - from.getTime()
  const diffDays = diffMs / (1000 * 60 * 60 * 24)

  // Align buckets to calendar boundaries, same as ES calendar_interval
  const buckets: Date[] = []
  if (diffDays <= 1) {
    // hour-aligned buckets
    const start = new Date(from)
    start.setMinutes(0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 60 * 60 * 1000)) {
      buckets.push(new Date(t))
    }
  } else if (diffDays <= 14) {
    // day-aligned buckets
    const start = new Date(from)
    start.setHours(0, 0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 24 * 60 * 60 * 1000)) {
      buckets.push(new Date(t))
    }
  } else {
    // week-aligned buckets (Monday)
    const start = new Date(from)
    const day = start.getDay()
    start.setDate(start.getDate() - (day === 0 ? 6 : day - 1))
    start.setHours(0, 0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 7 * 24 * 60 * 60 * 1000)) {
      buckets.push(new Date(t))
    }
  }

  const trend = buckets.map((t) => ({
    key_as_string: t.toISOString(),
    key: t.getTime(),
    doc_count: Math.floor(30 + Math.random() * 80),
    users: { value: Math.floor(5 + Math.random() * 20) }
  }))

  return {
    aggregations: {
      total_calls: { value: 1247 },
      active_users: { value: 38 },
      avg_duration: { value: 4320 },
      total_input_tokens: { value: 2_340_000 },
      total_output_tokens: { value: 890_000 },
      total_skills: { value: 10 },
      total_tools: { value: 27 },
      total_skill_calls: { value: 1711 },
      total_tool_calls: { value: 6538 },
      by_skill: {
        buckets: [
          { key: "代码审查",     doc_count: 312 },
          { key: "需求分析",     doc_count: 278 },
          { key: "文档生成",     doc_count: 245 },
          { key: "单元测试",     doc_count: 198 },
          { key: "SQL优化",      doc_count: 167 },
          { key: "接口设计",     doc_count: 143 },
          { key: "日志分析",     doc_count: 121 },
          { key: "数据清洗",     doc_count: 98  },
          { key: "性能诊断",     doc_count: 87  },
          { key: "安全扫描",     doc_count: 62  }
        ]
      },
      by_tool: {
        buckets: [
          { key: "git_workflow",       doc_count: 412 },
          { key: "browser_playwright", doc_count: 356 },
          { key: "manage_skill",       doc_count: 298 },
          { key: "manage_scheduler",   doc_count: 241 },
          { key: "web_search",         doc_count: 198 },
          { key: "db_query",           doc_count: 163 },
          { key: "create_pr",          doc_count: 134 },
          { key: "run_tests",          doc_count: 112 },
          { key: "search_code",        doc_count: 98  },
          { key: "notify",             doc_count: 76  }
        ]
      },
      by_tool_all: {
        buckets: [
          { key: "read_file",          doc_count: 1823 },
          { key: "write_file",         doc_count: 1245 },
          { key: "execute",            doc_count: 987  },
          { key: "grep",               doc_count: 876  },
          { key: "glob",               doc_count: 654  },
          { key: "git_workflow",       doc_count: 412  },
          { key: "browser_playwright", doc_count: 356  },
          { key: "manage_skill",       doc_count: 298  },
          { key: "edit_file",          doc_count: 267  },
          { key: "manage_scheduler",   doc_count: 241  },
          { key: "web_search",         doc_count: 198  },
          { key: "list_directory",     doc_count: 187  },
          { key: "db_query",           doc_count: 163  },
          { key: "task",               doc_count: 156  },
          { key: "task_output",        doc_count: 148  },
          { key: "create_pr",          doc_count: 134  },
          { key: "search_tool",        doc_count: 128  },
          { key: "run_tests",          doc_count: 112  },
          { key: "search_code",        doc_count: 98   },
          { key: "code_exec",          doc_count: 92   },
          { key: "notify",             doc_count: 76   },
          { key: "inspect_tool",       doc_count: 64   },
          { key: "write_todos",        doc_count: 58   },
          { key: "invoke_deferred_tool", doc_count: 45 },
          { key: "save_code_exec_tool", doc_count: 32  }
        ]
      },
      trend: { buckets: trend }
    }
  }
}

function makeMockModelStats(): unknown {
  return {
    aggregations: {
      by_model: {
        buckets: [
          { key: "claude-sonnet-4-6", doc_count: 620, success_count: { doc_count: 578 }, avg_duration: { value: 3800 }, total_input_tokens: { value: 1_200_000 }, total_output_tokens: { value: 430_000 } },
          { key: "claude-opus-4-6",   doc_count: 280, success_count: { doc_count: 265 }, avg_duration: { value: 8200 }, total_input_tokens: { value: 780_000 },  total_output_tokens: { value: 310_000 } },
          { key: "claude-haiku-4-5",  doc_count: 347, success_count: { doc_count: 259 }, avg_duration: { value: 1100 }, total_input_tokens: { value: 360_000 },  total_output_tokens: { value: 150_000 } }
        ]
      },
      by_tier: {
        buckets: [
          { key: "high",   doc_count: 280 },
          { key: "medium", doc_count: 620 },
          { key: "low",    doc_count: 347 }
        ]
      },
      by_layer: {
        buckets: [
          { key: "user_explicit",   doc_count: 210 },
          { key: "skill_override",  doc_count: 390 },
          { key: "auto_routing",    doc_count: 647 }
        ]
      }
    }
  }
}

function makeMockUserStats(range: TimeRange): unknown {
  const from = new Date(range.from)
  const to = new Date(range.to)
  const diffMs = to.getTime() - from.getTime()
  const diffDays = diffMs / (1000 * 60 * 60 * 24)

  const trendBuckets: Date[] = []
  if (diffDays <= 1) {
    const start = new Date(from); start.setMinutes(0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 60 * 60 * 1000)) trendBuckets.push(new Date(t))
  } else {
    const start = new Date(from); start.setHours(0, 0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 24 * 60 * 60 * 1000)) trendBuckets.push(new Date(t))
  }

  const trend = trendBuckets.map((t) => ({
    key_as_string: t.toISOString(),
    key: t.getTime(),
    doc_count: 0,
    users: { value: Math.floor(3 + Math.random() * 15) }
  }))

  return {
    aggregations: {
      top_users: {
        buckets: [
          { key: "10010001", doc_count: 142, user_name: { buckets: [{ key: "张三", doc_count: 142 }] }, org_name: { buckets: [{ key: "零售一部", doc_count: 142 }] }, success_count: { doc_count: 130 } },
          { key: "10010002", doc_count: 118, user_name: { buckets: [{ key: "李四", doc_count: 118 }] }, org_name: { buckets: [{ key: "零售二部", doc_count: 118 }] }, success_count: { doc_count: 110 } },
          { key: "10010003", doc_count: 97,  user_name: { buckets: [{ key: "王五", doc_count: 97  }] }, org_name: { buckets: [{ key: "企业金融部", doc_count: 97  }] }, success_count: { doc_count: 89  } },
          { key: "10010004", doc_count: 85,  user_name: { buckets: [{ key: "赵六", doc_count: 85  }] }, org_name: { buckets: [{ key: "零售一部", doc_count: 85  }] }, success_count: { doc_count: 72  } },
          { key: "10010005", doc_count: 73,  user_name: { buckets: [{ key: "钱七", doc_count: 73  }] }, org_name: { buckets: [{ key: "风险管理部", doc_count: 73  }] }, success_count: { doc_count: 68  } },
          { key: "10010006", doc_count: 61,  user_name: { buckets: [{ key: "孙八", doc_count: 61  }] }, org_name: { buckets: [{ key: "科技部",    doc_count: 61  }] }, success_count: { doc_count: 55  } }
        ]
      },
      by_org: {
        buckets: [
          { key: "零售一部", doc_count: 430 },
          { key: "零售二部", doc_count: 318 },
          { key: "企业金融部", doc_count: 245 },
          { key: "风险管理部", doc_count: 189 },
          { key: "科技部", doc_count: 65 }
        ]
      },
      by_version: {
        buckets: [
          { key: "1.3.0", doc_count: 512, unique_users: { value: 98 } },
          { key: "1.2.5", doc_count: 298, unique_users: { value: 62 } },
          { key: "1.2.0", doc_count: 187, unique_users: { value: 41 } },
          { key: "1.1.x", doc_count: 143, unique_users: { value: 28 } },
          { key: "1.0.x", doc_count: 107, unique_users: { value: 19 } }
        ]
      },
      user_trend: { buckets: trend }
    }
  }
}

function makeMockProductivity(range: TimeRange): unknown {
  const from = new Date(range.from)
  const to = new Date(range.to)
  const diffMs = to.getTime() - from.getTime()
  const diffDays = diffMs / (1000 * 60 * 60 * 24)

  const trendBuckets: Date[] = []
  if (diffDays <= 1) {
    const start = new Date(from); start.setMinutes(0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 60 * 60 * 1000)) trendBuckets.push(new Date(t))
  } else {
    const start = new Date(from); start.setHours(0, 0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 24 * 60 * 60 * 1000)) trendBuckets.push(new Date(t))
  }

  const trend = trendBuckets.map((t) => ({
    key_as_string: t.toISOString(),
    key: t.getTime(),
    doc_count: Math.floor(2 + Math.random() * 12)
  }))

  return {
    aggregations: {
      commit_trend: { buckets: trend },
      total_insertions:   { value: 14820 },
      total_deletions:    { value: 6430 },
      total_files_changed:{ value: 892 },
      total_commits:      { value: 187 },
      active_users:       { value: 24 }
    }
  }
}

function makeMockFeedback(range: TimeRange, granularity: Granularity): unknown {
  const interval = getCalendarInterval(granularity, range.from, range.to)
  const from = new Date(range.from)
  const to = new Date(range.to)

  const buckets: Date[] = []
  if (interval === "hour") {
    const start = new Date(from)
    start.setMinutes(0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 60 * 60 * 1000)) {
      buckets.push(new Date(t))
    }
  } else if (interval === "day") {
    const start = new Date(from)
    start.setHours(0, 0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 24 * 60 * 60 * 1000)) {
      buckets.push(new Date(t))
    }
  } else {
    const start = new Date(from)
    const day = start.getDay()
    start.setDate(start.getDate() - (day === 0 ? 6 : day - 1))
    start.setHours(0, 0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 7 * 24 * 60 * 60 * 1000)) {
      buckets.push(new Date(t))
    }
  }

  const trend = buckets.map((t) => {
    const likes = Math.floor(5 + Math.random() * 20)
    const dislikes = Math.floor(2 + Math.random() * 12)
    return {
      key_as_string: t.toISOString(),
      key: t.getTime(),
      doc_count: likes + dislikes,
      likes: { doc_count: likes },
      dislikes: { doc_count: dislikes }
    }
  })

  const dislikeByType = {
    slow: { doc_count: 58 },
    not_helpful: { doc_count: 74 },
    inaccurate: { doc_count: 39 },
    unclear: { doc_count: 46 },
    unsafe: { doc_count: 11 },
    other: { doc_count: 27 }
  }

  const recentComments = [
    {
      eventTime: new Date(to.getTime() - 10 * 60 * 1000).toISOString(),
      properties: {
        dislikeType: "other",
        dislikeTypeLabel: "其他原因",
        dislikeText: "希望能支持更精细的输出格式控制。"
      }
    },
    {
      eventTime: new Date(to.getTime() - 25 * 60 * 1000).toISOString(),
      properties: {
        dislikeType: "inaccurate",
        dislikeTypeLabel: "信息不准确",
        dislikeText: "依赖版本建议和项目实际不一致。"
      }
    },
    {
      eventTime: new Date(to.getTime() - 40 * 60 * 1000).toISOString(),
      properties: {
        dislikeType: "slow",
        dislikeTypeLabel: "太慢了",
        dislikeText: "等待响应时间偏长，尤其在长上下文里。"
      }
    },
    {
      eventTime: new Date(to.getTime() - 55 * 60 * 1000).toISOString(),
      properties: {
        dislikeType: "unclear",
        dislikeTypeLabel: "表述不清楚",
        dislikeText: "可以多给一步一步的解释。"
      }
    }
  ]

  return {
    aggregations: {
      total_likes: {
        doc_count: 386,
        unique_users: { value: 132 }
      },
      total_dislikes: {
        doc_count: 255,
        unique_users: { value: 96 }
      },
      dislike_by_type: { buckets: dislikeByType },
      trend: { buckets: trend },
      recent_dislike_comments: {
        doc_count: recentComments.length,
        latest: {
          hits: {
            hits: recentComments.map((item) => ({
              _source: item
            }))
          }
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────
// IPC Registration
// ─────────────────────────────────────────────────────────

export function registerDashboardHandlers(_ipcMain: typeof ipcMain): void {
  // Check if current user is allowed to see the dashboard
  _ipcMain.handle("dashboard:isAllowed", async () => {
    // In development mode, always allow access
    if (import.meta.env.DEV) return true
    const userInfo = getUserInfo()
    const ystId = userInfo?.ystId?.trim()
    if (!ystId) return false
    return ALLOWED_YST_IDS.has(ystId)
  })

  _ipcMain.handle(
    "dashboard:overview",
    async (_, range: TimeRange, granularity: Granularity) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockOverview(range) }
      try {
        return { success: true, data: await fetchOverview(range, granularity) }
      } catch (e) {
        console.error("[Dashboard] overview error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:modelStats",
    async (_, range: TimeRange, granularity: Granularity) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockModelStats() }
      try {
        return { success: true, data: await fetchModelStats(range, granularity) }
      } catch (e) {
        console.error("[Dashboard] modelStats error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:userStats",
    async (_, range: TimeRange, granularity: Granularity) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockUserStats(range) }
      try {
        return { success: true, data: await fetchUserStats(range, granularity) }
      } catch (e) {
        console.error("[Dashboard] userStats error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:productivity",
    async (_, range: TimeRange, granularity: Granularity) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockProductivity(range) }
      try {
        return { success: true, data: await fetchProductivity(range, granularity) }
      } catch (e) {
        console.error("[Dashboard] productivity error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:feedback",
    async (_, range: TimeRange, granularity: Granularity) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockFeedback(range, granularity) }
      try {
        return { success: true, data: await fetchFeedback(range, granularity) }
      } catch (e) {
        console.error("[Dashboard] feedback error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:exportExcel",
    async (
      _,
      sheets: Array<{ name: string; header: string[]; rows: (string | number)[][] }>
    ) => {
      try {
        // Dynamic import xlsx to avoid bundling issues
        const XLSX = await import("xlsx")

        const wb = XLSX.utils.book_new()
        for (const sheet of sheets) {
          const wsData = [sheet.header, ...sheet.rows]
          const ws = XLSX.utils.aoa_to_sheet(wsData)

          // Auto-size columns based on content
          const colWidths = sheet.header.map((h, i) => {
            let maxLen = h.length
            for (const row of sheet.rows) {
              const cellLen = String(row[i] ?? "").length
              if (cellLen > maxLen) maxLen = cellLen
            }
            return { wch: Math.min(maxLen + 4, 40) }
          })
          ws["!cols"] = colWidths

          XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31))
        }

        const win = BrowserWindow.getFocusedWindow()
        const result = await dialog.showSaveDialog(win ?? BrowserWindow.getAllWindows()[0], {
          title: "导出运营面板数据",
          defaultPath: `运营面板数据_${new Date().toISOString().slice(0, 10)}.xlsx`,
          filters: [{ name: "Excel", extensions: ["xlsx"] }]
        })

        if (result.canceled || !result.filePath) {
          return { success: false, canceled: true }
        }

        const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" })
        fs.writeFileSync(result.filePath, buf)

        return { success: true, filePath: result.filePath }
      } catch (e) {
        console.error("[Dashboard] exportExcel error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )
}
