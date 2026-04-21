import type { MarketApiResponse, MarketItem, MarketItemType } from "../../api/market"

const MOCK_CREATED_AT = "2026-01-01T00:00:00.000Z"

export const MOCK_MARKET_DATA: Record<MarketItemType, MarketItem[]> = {
  skill: [
    {
      "name": "java-connection-pool-validator",
      "chinese_name": "数据库连接池参数校验与修复",
      "category": "治理类场景/云应用架构转型治理",
      "featured": "精品",
      "version": "1.0.2",
      "user_id": "80362331",
      "guidance": "入口1：帮我检测并修复工作区下某个项目的数据库连接池规范性问题\r\n入口2：云效数据库连接池问题检测导出文件在C:\\Users\\yunxiaolist.xlsx(提供目录),帮我修复工作区下相应项目问题",
      "ip": "99.12.24.118",
      "description": "数据库连接池参数校验与修复",
      "filename": "java-connection-pool-validator.zip",
      "created_at": "2026-03-19T10:25:23.014023+00:00"
    },
    {
      "name": "ssrf-fixer",
      "chinese_name": "SSRF问题修复",
      "category": "治理类场景/应用安全",
      "featured": "精品",
      "version": "1.0.0",
      "user_id": "80374521",
      "guidance": "",
      "ip": "",
      "description": "SSRF（服务端请求伪造）漏洞修复技能",
      "filename": "ssrf-fixer.zip",
      "created_at": "2026-03-20T06:27:28.162765+00:00"
    },
    {
      "name": "high-arch-redline-fix",
      "chinese_name": "架构红线高整改等级问题智能检测与修复",
      "category": "治理类场景/架构红线",
      "featured": "精品",
      "version": "1.0.0",
      "user_id": "80296199",
      "guidance": "选择其一提问：\r\n1.清单模式：进行高优红线问题修复，问题清单在D:\\问题列表.xlsx，对应的发布单元值为 **\r\n2.扫描模式：对本工程进行红线问题扫描及修复",
      "ip": "99.17.200.216",
      "description": "针对六种高优先级的红线问题进行检测和修复，分为两种模式 1. **扫描模式**：无Excel清单时，自动扫描项目识别问题 2. **清单模式**：有Excel清单时，直接按清单修复",
      "filename": "high-arch-redline-fix.zip",
      "created_at": "2026-03-24T09:45:57.552800+00:00"
    },
    {
      "name": "frontend-code-modifier",
      "chinese_name": "前端项目代码改造开发智能助手",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "80280724",
      "guidance": "",
      "ip": "99.6.151.133",
      "description": "本技能帮助用户读取需求文档或解析用户输入的需求，结合现有前端代码提炼设计风格，自动修改代码生成符合要求的前端代码。",
      "filename": "frontend-code-modifier.zip",
      "created_at": "2026-03-26T11:29:02.282864+00:00"
    },
    {
      "name": "understand",
      "chinese_name": "架构分析",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "256963",
      "guidance": "",
      "ip": "99.17.200.61",
      "description": "用于分析工程架构，会在当前目录下生成知识图谱，knowledge-graph.json",
      "filename": "understand-1.1.0.zip",
      "created_at": "2026-03-31T06:04:31.796602+00:00"
    },
    {
      "name": "generate-uat-test-cases",
      "chinese_name": "生成UAT测试案例",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "80291354",
      "guidance": "提供项目名称及设计文档路径，生成测试案例Excel，用于精益测试案例Excel导入",
      "ip": "99.6.151.81",
      "description": "根据项目名称及设计文档内容生成UAT测试案例Excel文件，模板格式已固化在技能中，无需额外提供模板。",
      "filename": "SKILL.md",
      "created_at": "2026-04-01T06:00:33.863265+00:00"
    },
    {
      "name": "generate-ui-html",
      "chinese_name": "html页面生成",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.6",
      "user_id": "80311086",
      "guidance": "请使用generate-ui-html 技能帮我处理相关任务。\r\n需求说明：使用vue/react<请补充>",
      "ip": "99.17.200.89",
      "description": "可以选择过vue或者react生成html页面，如为vue就是vue2+elementui生成html页面，react就是react18+antd5",
      "filename": "generate-ui-html.md",
      "created_at": "2026-04-01T06:59:07.633963+00:00"
    },
    {
      "name": "requirements-extractor",
      "chinese_name": "需求文档读取",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "80280724",
      "guidance": "可以读取文档格式为docx、doc、txt、md文档的需求文件",
      "ip": "99.6.151.133",
      "description": "",
      "filename": "requirements-extractor.zip",
      "created_at": "2026-04-02T08:49:31.093969+00:00"
    },
    {
      "name": "agent-browser",
      "chinese_name": "agent-browser控制浏览器",
      "category": "通用场景",
      "featured": "",
      "version": "1.0.7",
      "user_id": "80293078",
      "guidance": "你可以说：只能使用agent-browser skill 打开百度搜索招商银行今天的股票价格发给我",
      "ip": "99.17.200.166",
      "description": "- agent-browser控制浏览器\r\n- 大于等于【 V0.1.11 】版本支持\r\n- 行内镜像可能安装不了，切换镜像：npm config set registry https://registry.npmmirror.com",
      "filename": "agent-browser-clawdbot-0.1.0.zip",
      "created_at": "2026-03-26T07:53:53.354489+00:00"
    },
    {
      "name": "browser-automation",
      "chinese_name": "chrome mcp操控浏览器（不要安装我，先查看详情）",
      "category": "通用场景",
      "featured": "",
      "version": "1.0.10",
      "user_id": "293078",
      "guidance": "你可以这样说：使用chrome-mcp来打开chrome访问百度搜索招商银行",
      "ip": "99.17.200.166",
      "description": "【功能】\r\n无需新开浏览器，直接在当前浏览器操作，继承cookie\r\n\r\n【注意事项】\r\n1.行内镜像装不了mcp-chrome-bridger。切换镜像：npm config set registry https://registry.npmmirror.com\r\n2.需要下載以及开启浏览器插件，地址：https://doc.cmbchina.com/f/v?id=zf948X\r\n（目录：插件/mcp-chrome-extension-v1.0.22.zip）\r\n3.浏览器插件需要启动“连接”\r\n4.安装了mcp之后，需要去mcp的目录下手动开启这个mcp\r\n5.新开一个会话使用",
      "filename": "mcp-chrome-0.1.1 (1).zip",
      "created_at": "2026-04-02T07:17:33.081336+00:00"
    },
    {
      "name": "za38-python",
      "chinese_name": "",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.1",
      "user_id": "80376020",
      "guidance": "直接给出ZA38相关的开发任务\r\n示例提问：“使用ZA38框架，帮我实现查询知识库功能，开发语言使用python”。",
      "ip": "99.12.43.152",
      "description": "当用户提问ZA38框架相关问题，且技术语言是python时，使用该技能能查阅相关技术文档，完成指定的开发任务，或者生成对应组件的代码示例。",
      "filename": "za38-python.zip",
      "created_at": "2026-04-03T02:51:11.337001+00:00"
    },
    {
      "name": "analyse_sql",
      "chinese_name": "慢SQL分析技能",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "80376020",
      "guidance": "示例提问:\r\n1. 帮我获取慢SQL问题列表\r\n2.帮我分析慢SQL问题，问题ID:XXX\r\nps: 由于要获取dbaas平台数据帮助分析，需要使用浏览器操作工具，开始执行后，用户需要在打开的浏览器先扫码登录一下，如果浏览器操作工具不支持执行脚本，还需要根据模型的反馈在浏览器控制台手动获取登录信息提供给模型。",
      "ip": "99.12.43.152",
      "description": "帮助用户分析生产上被扫描出来的慢SQL问题。(数据来源:dbaas平台)\r\n问题清单会同时出现在dbaas平台、质效工坊、架构管理平台。如有收到相关慢SQL问题，可使用该技能帮助分析定位。",
      "filename": "analyse_sql.zip",
      "created_at": "2026-04-03T06:51:00.564376+00:00"
    },
    {
      "name": "gsd-lite",
      "chinese_name": "需求转中间态文档",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "",
      "guidance": "",
      "ip": "99.17.200.160",
      "description": "需求分析",
      "filename": "gsd-lite-4.zip",
      "created_at": "2026-04-07T08:47:49.479839+00:00"
    },
    {
      "name": "za21-upgrader",
      "chinese_name": "ZA21版本升级",
      "category": "治理类场景/云应用架构转型治理",
      "featured": "精品",
      "version": "1.0.4",
      "user_id": "80319179",
      "guidance": "需要指定升级的目标版本号（必输），发布单元信息（可选，如果不指定会以“mvn clean package”的命令编译，运行文件会去“工作空间/target”，不支持多module项目结构），父pom文件地址（可选，指定了该目录会在执行项目编译时父pom先install）\r\n1）、有父pom\r\n示例：升级za21版本到6.0.1，发布单元为LF39.05_bcentpipmmng，父pom地址为D:\\back\\LF39.05_bcwplus_commons\\parent_mico\\1.8.3-MICRO\\pom.xml\r\n2）、无父pom\r\n示例：升级za21版本到6.0.1，发布单元为LF39.05_bcentpipmmng",
      "ip": "172.31.80.1",
      "description": "ZA21版本升级",
      "filename": "za21-upgrader.zip",
      "created_at": "2026-03-18T03:01:02.392050+00:00"
    },
    {
      "name": "hardcoded-password-fixer",
      "chinese_name": "硬编码密码修复",
      "category": "治理类场景/应用安全",
      "featured": "精品",
      "version": "1.0.4",
      "user_id": "80296748",
      "guidance": "帮我处理硬编码密码问题",
      "ip": "99.6.151.72",
      "description": "在柯南系统中筛选硬编码密码风险类型并导出excel，将excel放在项目根目录中，技能会自动读取excel中的问题文件进行硬编码密码问题修复，如未找到excel将进行所有文件的扫描和修复",
      "filename": "hardcoded-password-fixer.zip",
      "created_at": "2026-03-19T09:43:27.829829+00:00"
    },
    {
      "name": "cmb-spring-doc-generator",
      "chinese_name": "Spring Boot API 文档生成器",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "80234614",
      "guidance": "",
      "ip": "99.6.151.136",
      "description": "",
      "filename": "cmb-spring-doc-generator.zip",
      "created_at": "2026-04-10T09:58:45.571723+00:00"
    },
    {
      "name": "web-code-generator",
      "chinese_name": "个保需求转前端代码",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "80311086",
      "guidance": "使用web-code-generator，帮我完成如下功能：<描述需求>\r\n接口参考：https://xftyapi-dev.paas.cmbchina.cn/project/2379/interface/api/180715（yapi文档）",
      "ip": "99.17.200.89",
      "description": "用于个保需求转前端代码",
      "filename": "web-code-generator.zip",
      "created_at": "2026-04-13T02:41:07.602052+00:00"
    },
    {
      "name": "pixso-react-generator",
      "chinese_name": "pixso生成前端代码",
      "category": "研发类场景/应用类研发",
      "featured": "",
      "version": "1.0.0",
      "user_id": "",
      "guidance": "",
      "ip": "99.17.200.204",
      "description": "pixso生成前端代码",
      "filename": "pixso-react-generator.zip",
      "created_at": "2026-04-13T03:33:08.573781+00:00"
    },
    {
      "name": "requirement-evaluator",
      "chinese_name": "需求文档评测",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "80383692",
      "guidance": "",
      "ip": "99.17.200.207",
      "description": "",
      "filename": "requirement-evaluator.zip",
      "created_at": "2026-04-13T08:22:55.196246+00:00"
    },
    {
      "name": "encrypt-password",
      "chinese_name": "明文密码加密",
      "category": "治理类场景/应用安全",
      "featured": "精品",
      "version": "1.0.14",
      "user_id": "80331431",
      "guidance": "帮我加密项目中的明文密码",
      "ip": "99.17.200.215",
      "description": "仅支持ZA21项目：使用ZA21 SDK加密工作区中.yaml、.properties文件里面的明文密码，支持从柯南平台导入明文密码问题。",
      "filename": "encrypt-password (14).zip",
      "created_at": "2026-03-19T11:10:53.057581+00:00"
    },
    {
      "name": "prd-doc-parser",
      "chinese_name": "需求文档转任务",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.1",
      "user_id": "80327848",
      "guidance": "",
      "ip": "99.17.200.234",
      "description": "需求文档转成对应的任务，并提供一个基础布局，用户可以进行修改",
      "filename": "docToTask.zip",
      "created_at": "2026-04-13T09:24:59.728721+00:00"
    },
    {
      "name": "cmb-backend-config-gen",
      "chinese_name": "ZA21云服务配置生成器",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.4",
      "user_id": "IT007226",
      "guidance": "帮我添加Redis、Kafka、Elasticsearch、RabbitMQ配置",
      "ip": "99.15.231.197",
      "description": "云服务配置添加",
      "filename": "cmb-backend-config-gen.zip",
      "created_at": "2026-04-10T02:36:42.534058+00:00"
    },
    {
      "name": "playwright-cli",
      "chinese_name": "playwright-cli操控浏览器",
      "category": "通用场景",
      "featured": "",
      "version": "1.0.6",
      "user_id": "293078 / 杨琪",
      "guidance": "你可以说：只能使用playwright-cli skill打开浏览器，访问百度，搜索招商银行今天的股票价格",
      "ip": "99.17.200.166",
      "description": "- playwright-cli操控浏览器\r\n- 大于等于【 V0.1.11 】版本支持\r\n- 行内镜像可能安装不了，切换镜像：npm config set registry https://registry.npmmirror.com",
      "filename": "playwright-cli.zip",
      "created_at": "2026-03-26T08:04:51.036218+00:00"
    },
    {
      "name": "pyspark-upgrader",
      "chinese_name": "pyspark离线分析平台脚本升级",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.3",
      "user_id": "80251989",
      "guidance": "可提供目录地址或者具体文件地址进行升级到离线平台最新版本或者明确指定的某个版本。",
      "ip": "99.6.151.132",
      "description": "支持离线分析平台上部署的PySpark脚本升级到Python 3.7.9和Spark 3.3.1语法（离线平台最新版本）。支持语法转换、废弃API替换、依赖检查等功能。",
      "filename": "pyspark-upgrader.zip",
      "created_at": "2026-04-15T12:13:56.637167+00:00"
    },
    {
      "name": "ddl-generator",
      "chinese_name": "DDL脚本生成",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.0",
      "user_id": "319867 / 陈杭",
      "guidance": "输入表结构设计字段",
      "ip": "99.6.151.230",
      "description": "根据表结构设计生成DDL脚本。用户提供表名、字段列表（字段名、类型、是否主键、描述）时使用此技能。自动匹配同目录下已有DDL脚本风格，生成符合项目规范的建表脚本，保存到DB/库名@实例名/表空间/目录下。",
      "filename": "SKILL.md",
      "created_at": "2026-04-17T02:27:51.269515+00:00"
    },
    {
      "name": "prcjson-za21-refactor",
      "chinese_name": "springmvc重构为springboot项目",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.1",
      "user_id": "362667 / 梁辰",
      "guidance": "",
      "ip": "99.6.149.54",
      "description": "edge-framework PRCJson项目重构为ZA21最新框架版本",
      "filename": "prcjson-za21-refactor.zip",
      "created_at": "2026-04-17T02:53:24.112801+00:00"
    }, {
      "name": "demand-code-reviewer",
      "chinese_name": "市场W+前端存量代码优化",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.1",
      "user_id": "280316 / 敬琳萍",
      "guidance": "",
      "ip": "99.17.200.203",
      "description": "",
      "filename": "demand-code-reviewer.zip",
      "created_at": "2026-04-17T07:11:34.055824+00:00"
    },
    {
      "name": "cerulean-insight-frontend",
      "chinese_name": "市场W+前端代码生成规范",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.2",
      "user_id": "327848 / 谢雨卿",
      "guidance": "",
      "ip": "99.17.200.234",
      "description": "支持上传需求文档，生成前端页面；\r\n支持提供yapi地址，进行接口联调；\r\n支持根据需求文档提供可预览的推荐布局。",
      "filename": "front_tokens.zip",
      "created_at": "2026-04-13T09:26:34.501368+00:00"
    },
    {
      "name": "cmb-recover-review",
      "chinese_name": "应用自愈自动识别修复上报",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.1",
      "user_id": "258540 / 陈莹",
      "guidance": "",
      "ip": "99.6.151.119",
      "description": "支持java应用自动识别代码容错机制缺失并实现自动修复及实际自愈场景上报架构办",
      "filename": "cmb-recover-review.zip",
      "created_at": "2026-04-17T10:19:43.513657+00:00"
    },
    {
      "name": "code-refactor",
      "chinese_name": "java代码重构",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.1",
      "user_id": "325150 / 赵洪苛",
      "guidance": "",
      "ip": "99.17.200.242",
      "description": "对指定的Java方法进行调用链路分析和业务代码重构，以符合行内Java开发规范",
      "filename": "code-refactor.zip",
      "created_at": "2026-04-20T07:26:32.174865+00:00"
    },
    {
      "name": "unusage-code-delete",
      "chinese_name": "无用接口下线",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.1",
      "user_id": "325150 / 赵洪苛",
      "guidance": "用户需要指定以下参数之一（互斥）：\r\n\r\n- **targetPath**: 接口路径，格式为REST路径，如 `/api/user/getUserInfo` 或 `/user/info`\r\n- **targetMethod**: 类名.方法名，如 `UserController.getUserInfo` 或 `com.example.controller.UserController.getUserInfo`",
      "ip": "99.17.200.242",
      "description": "无用接口下线技能。根据用户指定的接口路径或类名.方法名，从顶向下分析调用链路，删除接口方法及调用链路上所有无用的代码（Controller、Service、DAO、MyBatis XML、实体类）。仅当调用链上的代码没有其他引用时才执行删除。使用行号进行代码删除。使用场景：用户要求删除某个API接口、清理无用代码、接口下线。",
      "filename": "unusage-code-delete.zip",
      "created_at": "2026-03-20T00:59:29.537212+00:00"
    },
    {
      "name": "prd-to-frontend",
      "chinese_name": "市场W+需求转代码[初版]",
      "category": "研发场景",
      "featured": "",
      "version": "1.0.7",
      "user_id": "327848 / 谢雨卿",
      "guidance": "",
      "ip": "99.17.200.234",
      "description": "整合了需求转任务和市场W+前端代码生成规范这两个技能，可以上传需求，输入：解析需求并生成前端代码等关键信息",
      "filename": "front_all_Second.zip",
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
