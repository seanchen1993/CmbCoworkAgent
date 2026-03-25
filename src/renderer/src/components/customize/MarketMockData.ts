import type { MarketApiResponse, MarketItem, MarketItemType } from "../../api/market"

const MOCK_CREATED_AT = "2026-01-01T00:00:00.000Z"

const MOCK_MARKET_DATA: Record<MarketItemType, MarketItem[]> = {
  skill: [
    {
      name: "mock-code-review",
      chinese_name: "Mock 代码审查",
      description: "用于本地调试的 Market Mock 数据：代码审查技能示例。",
      filename: "mock-code-review.zip",
      created_at: MOCK_CREATED_AT,
      category: "开发效率",
      featured: "官方推荐",
      version: "1.0.0",
      guidance: "这是 mock 数据，接口失败时用于兜底展示。"
    },
    {
      name: "mock-api-docs",
      chinese_name: "Mock API 文档助手",
      description: "用于本地调试的 Market Mock 数据：API 文档生成技能示例。",
      filename: "mock-api-docs.zip",
      created_at: MOCK_CREATED_AT,
      category: "文档",
      featured: "热门",
      version: "1.0.0"
    }
  ],
  mcp: [
    {
      name: "mock-mcp-connector",
      chinese_name: "Mock MCP 连接器",
      description: "用于本地调试的 Market Mock 数据：MCP 连接器示例。",
      filename: "mock-mcp-connector.json",
      created_at: MOCK_CREATED_AT,
      category: "连接器",
      featured: "官方推荐",
      version: "1.0.0"
    }
  ],
  plugin: [
    {
      name: "mock-plugin-tools",
      chinese_name: "Mock 插件工具集",
      description: "用于本地调试的 Market Mock 数据：插件示例。",
      filename: "mock-plugin-tools.zip",
      created_at: MOCK_CREATED_AT,
      category: "插件",
      featured: "热门",
      version: "1.0.0"
    }
  ]
}

export const getMarketMockResponse = (type: MarketItemType): MarketApiResponse => {
  return {
    success: true,
    data: MOCK_MARKET_DATA[type]
  }
}
