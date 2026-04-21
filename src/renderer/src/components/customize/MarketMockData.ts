import type { MarketApiResponse, MarketItem, MarketItemType } from "../../api/market"

const MOCK_CREATED_AT = "2026-01-01T00:00:00.000Z"

export const MOCK_MARKET_DATA: Record<MarketItemType, MarketItem[]> = {
  skill: [
    {
      "name": "jav***or",
      "chinese_name": "数***复",
      "category": "治理类场景/云应用架构转型治理",
      "featured": "精品",
      "version": "1.0.2",
      "user_id": "80***31",
      "guidance": "入口1：帮我检测并修***区下相应项目问题",
      "ip": "99.***.***.118",
      "description": "数***",
      "filename": "jav***or.zip",
      "created_at": "2026-03-19T10:25:23.014023+00:00"
    },
    {
      "name": "ssr***er",
      "chinese_name": "S***复",
      "category": "治理类场景/应用安全",
      "featured": "精品",
      "version": "1.0.0",
      "user_id": "80***21",
      "guidance": "",
      "ip": "",
      "description": "SSRF（服务端请求***造）漏洞修复技能",
      "filename": "ssr***er.zip",
      "created_at": "2026-03-20T06:27:28.162765+00:00"
    },
    {
      "name": "hig***ix",
      "chinese_name": "架***复",
      "category": "治理类场景/架构红线",
      "featured": "精品",
      "version": "1.0.0",
      "user_id": "80***99",
      "guidance": "选择其一提问：\r\***线问题扫描及修复",
      "ip": "99.***.***.216",
      "description": "针对六种高优先级的红***，直接按清单修复",
      "filename": "hig***ix.zip",
      "created_at": "2026-03-24T09:45:57.552800+00:00"
    },
    {
      "name": "fro***er",
      "chinese_name": "前***手",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "80***24",
      "guidance": "",
      "ip": "99.***.***.133",
      "description": "本技能帮助用户读取需***要求的前端代码。",
      "filename": "fro***er.zip",
      "created_at": "2026-03-26T11:29:02.282864+00:00"
    },
    {
      "name": "und***nd",
      "chinese_name": "架***析",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "25***63",
      "guidance": "",
      "ip": "99.***.***.61",
      "description": "用于分析工程架构，会***aph.json",
      "filename": "und***.0.zip",
      "created_at": "2026-03-31T06:04:31.796602+00:00"
    },
    {
      "name": "gen***es",
      "chinese_name": "生***例",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "80***54",
      "guidance": "提供项目名称及设计文***例Excel导入",
      "ip": "99.***.***.81",
      "description": "根据项目名称及设计文***需额外提供模板。",
      "filename": "S***.md",
      "created_at": "2026-04-01T06:00:33.863265+00:00"
    },
    {
      "name": "gen***ml",
      "chinese_name": "h***成",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.6",
      "user_id": "80***86",
      "guidance": "请使用generat***act<请补充>",
      "ip": "99.***.***.89",
      "description": "可以选择过vue或者***18+antd5",
      "filename": "gen***ml.md",
      "created_at": "2026-04-01T06:59:07.633963+00:00"
    },
    {
      "name": "req***or",
      "chinese_name": "需***取",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "80***24",
      "guidance": "可以读取文档格式为d***d文档的需求文件",
      "ip": "99.***.***.133",
      "description": "",
      "filename": "req***or.zip",
      "created_at": "2026-04-02T08:49:31.093969+00:00"
    },
    {
      "name": "age***er",
      "chinese_name": "a***器",
      "category": "通用场景",
      "featured": "",
      "version": "1.0.7",
      "user_id": "80***78",
      "guidance": "你可以说：只能使用a***的股票价格发给我",
      "ip": "99.***.***.166",
      "description": "- agent-br***rror.com",
      "filename": "age***.0.zip",
      "created_at": "2026-03-26T07:53:53.354489+00:00"
    },
    {
      "name": "bro***on",
      "chinese_name": "c***）",
      "category": "通用场景",
      "featured": "",
      "version": "1.0.10",
      "user_id": "29***78",
      "guidance": "你可以这样说：使用c***百度搜索招商银行",
      "ip": "99.***.***.166",
      "description": "【功能】\r\n无需***新开一个会话使用",
      "filename": "mcp***1).zip",
      "created_at": "2026-04-02T07:17:33.081336+00:00"
    },
    {
      "name": "za3***on",
      "chinese_name": "",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.1",
      "user_id": "80***20",
      "guidance": "直接给出ZA38相关***python”。",
      "ip": "99.***.***.152",
      "description": "当用户提问ZA38框***组件的代码示例。",
      "filename": "za3***on.zip",
      "created_at": "2026-04-03T02:51:11.337001+00:00"
    },
    {
      "name": "ana***ql",
      "chinese_name": "慢***能",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "80***20",
      "guidance": "示例提问:\r\n1***信息提供给模型。",
      "ip": "99.***.***.152",
      "description": "帮助用户分析生产上被***能帮助分析定位。",
      "filename": "ana***ql.zip",
      "created_at": "2026-04-03T06:51:00.564376+00:00"
    },
    {
      "name": "gsd***te",
      "chinese_name": "需***档",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "",
      "guidance": "",
      "ip": "99.***.***.160",
      "description": "需***",
      "filename": "gsd***-4.zip",
      "created_at": "2026-04-07T08:47:49.479839+00:00"
    },
    {
      "name": "za2***er",
      "chinese_name": "Z***级",
      "category": "治理类场景/云应用架构转型治理",
      "featured": "精品",
      "version": "1.0.4",
      "user_id": "80***79",
      "guidance": "需要指定升级的目标版***tpipmmng",
      "ip": "172.***.***.1",
      "description": "Z***",
      "filename": "za2***er.zip",
      "created_at": "2026-03-18T03:01:02.392050+00:00"
    },
    {
      "name": "har***er",
      "chinese_name": "硬***复",
      "category": "治理类场景/应用安全",
      "featured": "精品",
      "version": "1.0.4",
      "user_id": "80***48",
      "guidance": "帮***",
      "ip": "99.***.***.72",
      "description": "在柯南系统中筛选硬编***文件的扫描和修复",
      "filename": "har***er.zip",
      "created_at": "2026-03-19T09:43:27.829829+00:00"
    },
    {
      "name": "cmb***or",
      "chinese_name": "S***器",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "80***14",
      "guidance": "",
      "ip": "99.***.***.136",
      "description": "",
      "filename": "cmb***or.zip",
      "created_at": "2026-04-10T09:58:45.571723+00:00"
    },
    {
      "name": "web***or",
      "chinese_name": "个***码",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "80***86",
      "guidance": "使用web-code***（yapi文档）",
      "ip": "99.***.***.89",
      "description": "用***",
      "filename": "web***or.zip",
      "created_at": "2026-04-13T02:41:07.602052+00:00"
    },
    {
      "name": "pix***or",
      "chinese_name": "p***码",
      "category": "研发类场景/应用类研发",
      "featured": "",
      "version": "1.0.0",
      "user_id": "",
      "guidance": "",
      "ip": "99.***.***.204",
      "description": "p***",
      "filename": "pix***or.zip",
      "created_at": "2026-04-13T03:33:08.573781+00:00"
    },
    {
      "name": "req***or",
      "chinese_name": "需***测",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "80***92",
      "guidance": "",
      "ip": "99.***.***.207",
      "description": "",
      "filename": "req***or.zip",
      "created_at": "2026-04-13T08:22:55.196246+00:00"
    },
    {
      "name": "enc***rd",
      "chinese_name": "明***密",
      "category": "治理类场景/应用安全",
      "featured": "精品",
      "version": "1.0.14",
      "user_id": "80***31",
      "guidance": "帮***",
      "ip": "99.***.***.215",
      "description": "仅支持ZA21项目：***入明文密码问题。",
      "filename": "enc***4).zip",
      "created_at": "2026-03-19T11:10:53.057581+00:00"
    },
    {
      "name": "prd***er",
      "chinese_name": "需***务",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.1",
      "user_id": "80***48",
      "guidance": "",
      "ip": "99.***.***.234",
      "description": "需求文档转成对应的任***用户可以进行修改",
      "filename": "doc***sk.zip",
      "created_at": "2026-04-13T09:24:59.728721+00:00"
    },
    {
      "name": "cmb***en",
      "chinese_name": "Z***器",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.4",
      "user_id": "IT***26",
      "guidance": "帮我添加Redis、***bbitMQ配置",
      "ip": "99.***.***.197",
      "description": "云***",
      "filename": "cmb***en.zip",
      "created_at": "2026-04-10T02:36:42.534058+00:00"
    },
    {
      "name": "pla***li",
      "chinese_name": "p***器",
      "category": "通用场景",
      "featured": "",
      "version": "1.0.6",
      "user_id": "29***杨琪",
      "guidance": "你可以说：只能使用p***行今天的股票价格",
      "ip": "99.***.***.166",
      "description": "- playwrig***rror.com",
      "filename": "pla***li.zip",
      "created_at": "2026-03-26T08:04:51.036218+00:00"
    },
    {
      "name": "pys***er",
      "chinese_name": "p***级",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.3",
      "user_id": "80***89",
      "guidance": "可提供目录地址或者具***指定的某个版本。",
      "ip": "99.***.***.132",
      "description": "支持离线分析平台上部***依赖检查等功能。",
      "filename": "pys***er.zip",
      "created_at": "2026-04-15T12:13:56.637167+00:00"
    },
    {
      "name": "ddl***or",
      "chinese_name": "D***成",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "31***陈杭",
      "guidance": "输***",
      "ip": "99.***.***.230",
      "description": "根据表结构设计生成D***表空间/目录下。",
      "filename": "S***.md",
      "created_at": "2026-04-17T02:27:51.269515+00:00"
    },
    {
      "name": "prc***or",
      "chinese_name": "s***目",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.1",
      "user_id": "36***梁辰",
      "guidance": "",
      "ip": "99.***.***.54",
      "description": "edge-frame***21最新框架版本",
      "filename": "prc***or.zip",
      "created_at": "2026-04-17T02:53:24.112801+00:00"
    }, {
      "name": "dem***er",
      "chinese_name": "市***化",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.1",
      "user_id": "28***琳萍",
      "guidance": "",
      "ip": "99.***.***.203",
      "description": "",
      "filename": "dem***er.zip",
      "created_at": "2026-04-17T07:11:34.055824+00:00"
    },
    {
      "name": "cer***nd",
      "chinese_name": "市***范",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.2",
      "user_id": "32***雨卿",
      "guidance": "",
      "ip": "99.***.***.234",
      "description": "支持上传需求文档，生***预览的推荐布局。",
      "filename": "fro***ns.zip",
      "created_at": "2026-04-13T09:26:34.501368+00:00"
    },
    {
      "name": "cmb***ew",
      "chinese_name": "应***报",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.1",
      "user_id": "25***陈莹",
      "guidance": "",
      "ip": "99.***.***.119",
      "description": "支持java应用自动***愈场景上报架构办",
      "filename": "cmb***ew.zip",
      "created_at": "2026-04-17T10:19:43.513657+00:00"
    },
    {
      "name": "cod***or",
      "chinese_name": "j***构",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.1",
      "user_id": "32***洪苛",
      "guidance": "",
      "ip": "99.***.***.242",
      "description": "对指定的Java方法***Java开发规范",
      "filename": "cod***or.zip",
      "created_at": "2026-04-20T07:26:32.174865+00:00"
    },
    {
      "name": "unu***te",
      "chinese_name": "无***线",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.1",
      "user_id": "32***洪苛",
      "guidance": "用户需要指定以下参数***serInfo`",
      "ip": "99.***.***.242",
      "description": "无用接口下线技能。根***代码、接口下线。",
      "filename": "unu***te.zip",
      "created_at": "2026-03-20T00:59:29.537212+00:00"
    },
    {
      "name": "prd***nd",
      "chinese_name": "市***]",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.7",
      "user_id": "32***雨卿",
      "guidance": "",
      "ip": "99.***.***.234",
      "description": "整合了需求转任务和市***端代码等关键信息",
      "filename": "fro***nd.zip",
      "created_at": "2026-04-14T06:19:15.712799+00:00"
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
