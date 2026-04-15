import type { MarketApiResponse, MarketItem, MarketItemType } from "../../api/market"

const MOCK_CREATED_AT = "2026-01-01T00:00:00.000Z"

export const MOCK_MARKET_DATA: Record<MarketItemType, MarketItem[]> = {
  skill: [
    {
      name: "mock-code-review",
      chinese_name: "Mock 代码审查",
      description:
        "用于本地调试的 Market Mock 数据：代码审查技能示例。\n支持 PR 变更扫描、风险分级与修复建议。",
      filename: "mock-code-review.zip",
      created_at: MOCK_CREATED_AT,
      category: "开发效率",
      featured: "官方推荐",
      version: "1.0.0",
      guidance: "这是 mock 数据，接口失败时用于兜底展示。\n可直接用于 UI 多行文本展示测试。"
    },
    {
      name: "mock-api-docs",
      chinese_name: "Mock API 文档助手",
      description:
        "用于本地调试的 Market Mock 数据：API 文档生成技能示例。\n可根据接口定义自动生成接入说明与示例。",
      filename: "mock-api-docs.zip",
      created_at: MOCK_CREATED_AT,
      category: "文档",
      featured: "热门",
      version: "1.0.0"
    },
    {
      name: "pinchtab",
      chinese_name: "pinchtab精品",
      description:
        "用于本地调试的 Market Mock 数据：日志分析技能示例。\n支持异常聚类、根因定位与告警摘要。",
      filename: "mock-log-analyzer.zip",
      created_at: MOCK_CREATED_AT,
      category: "运维",
      featured: "精品",
      version: "1.2.0"
    },
    {
      name: "mock-test-gen",
      chinese_name: "Mock 测试用例生成器",
      description:
        "用于本地调试的 Market Mock 数据：测试用例生成示例。\n根据函数签名生成边界值、异常流与回归用例。",
      filename: "mock-test-gen.zip",
      created_at: MOCK_CREATED_AT,
      category: "测试",
      featured: "个人",
      version: "0.9.3"
    }
  ],
  mcp: [
    {
      name: "mock-mcp-connector",
      chinese_name: "Mock MCP 连接器",
      description: "用于本地调试的 Market Mock 数据：MCP 连接器示例。\n默认提供只读查询能力。",
      filename: "mock-mcp-connector.json",
      created_at: MOCK_CREATED_AT,
      category: "连接器",
      featured: "官方推荐",
      version: "1.0.0"
    },
    {
      name: "mock-jira-mcp",
      chinese_name: "Mock Jira 连接器",
      description:
        "用于本地调试的 Market Mock 数据：Jira MCP 连接器示例。\n支持 issue 查询、状态流转与评论读取。",
      filename: "mock-jira-mcp.json",
      created_at: MOCK_CREATED_AT,
      category: "项目管理",
      featured: "热门",
      version: "1.1.0"
    },
    {
      name: "mock-confluence-mcp",
      chinese_name: "Mock Confluence 连接器",
      description:
        "用于本地调试的 Market Mock 数据：Confluence MCP 连接器示例。\n支持文档检索、页面摘要与知识聚合。",
      filename: "mock-confluence-mcp.json",
      created_at: MOCK_CREATED_AT,
      category: "知识库",
      featured: "精品",
      version: "1.0.5"
    }
  ],
  plugin: [
    {
      name: "mock-plugin-tools",
      chinese_name: "Mock 插件工具集",
      description:
        "用于本地调试的 Market Mock 数据：插件示例。\n包含命令模板、可视化卡片与状态提示组件。",
      filename: "mock-plugin-tools.zip",
      created_at: MOCK_CREATED_AT,
      category: "插件",
      featured: "热门",
      version: "1.0.0"
    },
    {
      name: "mock-plugin-ci-helper",
      chinese_name: "Mock CI 辅助插件",
      description:
        "用于本地调试的 Market Mock 数据：CI 辅助插件示例。\n支持流水线失败定位、日志提炼与修复建议。",
      filename: "mock-plugin-ci-helper.zip",
      created_at: MOCK_CREATED_AT,
      category: "工程化",
      featured: "官方推荐",
      version: "2.0.0"
    },
    {
      name: "mock-plugin-release-note",
      chinese_name: "Mock 发布说明插件",
      description:
        "用于本地调试的 Market Mock 数据：发布说明插件示例。\n根据提交记录自动生成版本说明与升级指南。",
      filename: "mock-plugin-release-note.zip",
      created_at: MOCK_CREATED_AT,
      category: "发布",
      featured: "个人",
      version: "1.3.2"
    }
  ]
}

export const getMarketMockResponse = (type: MarketItemType): MarketApiResponse => {
  return {
    success: true,
    data: MOCK_MARKET_DATA[type]
  }
}
