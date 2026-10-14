# 插件颜色跟随 DevClaw 主题

目前插件写 `color: "error"` 或 `color: "text"` 时，界面把这个名字直接交给浏览器，
浏览器不认识，颜色可能完全不生效。官方 2.1.290 的 TextProps/ThemeKey（包内声明
12223–12256 行）明确允许颜色含义名和原始颜色；含义名应跟随用户选择的主题。

这个窗口把官方列出的 23 个名字转为本工程已存在的主题 CSS 变量。它是使用方式
兼容：插件原来的名字可以直接使用，同时融入 DevClaw 的主题；不声称两个产品在
不同主题下的每个像素颜色一致。用户切换主题时，浏览器会自动使用新变量。

拟定对应关系：text→foreground；inverseText→background；inactive/subtle→
mutedForeground/tertiaryForeground；suggestion/remember/ide→statusInfo；success/
error/warning→statusNominal/statusCritical/statusWarning；merged/claude/permission/
planMode→accent；autoAccept→statusNominal；promptBorder/bashBorder→borderEmphasis/
statusWarning；diffAdded/diffRemoved→syntaxAddition/syntaxDeletion。Dimmed 的两种差异
颜色在相同变量上混入透明色；Word 的两种颜色先用相同差异变量。

只改渲染器 function-ui-style.ts，新增固定的颜色名解析助手和相邻回归。其他颜色如
`#ff0000`、`rgb(...)`、`var(...)` 保持原值，未知名字保持原值；不能用一个正常对象的
原型成员冒充颜色名。前景和背景都使用同一个解析器，原粗体、换行、边框和尺寸
不变。没有主进程、凭据、文件、权限、模型调用或存量主题格式的改变。

检查需要覆盖 23 个名字、未知名字与原型成员、原始颜色不变、前景和背景、同一
节点原数据不变；用现有主题调色板确认每个变量在所有预设里都有定义，并在真实
Electron 切换明暗主题后核对计算颜色。自定义 Claude 主题中的其他任意键、hover/
inverse 样式以及其他文字换行形式单独继续迭代，不把本窗口算作整套 Text 已对齐。

Root 方案检视已完成，独立第二检视通过后实施。
