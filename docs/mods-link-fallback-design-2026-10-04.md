# 链接兼容：不中断整个组件

本阶段承接真实组件失败通知，整体目标继续进行中。用户导入官方模组时，不能因一条不能打开的地址让整个面板报错。

## 原版依据

固定 Windows 2.1.289 二进制和声明完整性见 mods-latest-289-audit-2026-10-04.md；本次原版 plugin test 在 desktop/mobile 各 21 项，共 42 项通过，证据为 output/mods-289-link-contract.log 和原提取目录 link-probe。

实际结果明确区分两层：Link 构造器要求 href 是字符串，缺失、数字、null、对象拒绝；原始树出现这些值时宿主将该 Link 转为普通文字。空字符串、javascript/file/mailto/普通 http、空格、Unicode、带账号及路径含 @ 的地址转为文字，周围内容继续显示。HTTPS 与 localhost http 可点击；https://example.com 不要求补尾部斜线。超过 2048 字符仍拒绝整树，不能把边界上限错误说成普通降级。

首次探针误把 find 的父节点合并文本当成叶子，第二次混淆构造器与原始树；失败日志完整保留。最终分别断言实际绘制树和两层行为，没有靠延时隐藏问题。测试不代表实际官方桌面点击或外部浏览器打开。

## 实施边界

1. 保留现有 JSON、节点数、深度、文字、回调所属、内容保护及生命周期边界。href 字符串不超过 2048，控制字符仍拒绝；非字符串原始 href 只作为不可点击数据，在文字化时不 stringify 对象、布尔或数字。Link 构造器（普通和 Client）要求字符串，避免错误入参静默成功。
2. 新共享纯函数在完整树已验证后把不可点击 Link 换成 Text，保留其 children；Link 允许省略 children，没有 children 依次用 label、字符串 href、空文字。不复制 Link 属性到 DOM，也不给降级文字 onClick、href、tabIndex 或 link 角色。保留其他节点及旧句柄，正常树无需复制。归一化后的树再验证，避免生成节点突破边界。
3. 可打开地址继续只允许 ASCII、无 @、HTTPS 或 http://localhost；原文必须有明确 https:// 或 http:// 语法，并拒绝反斜线，解析后再检查真实 protocol/hostname/账号。不能把 WHATWG 自动纠正的 https:/example.com 或 http:localhost 等交给 shell.openExternal。去掉必须 URL 序列化完全相等的额外要求，使无尾斜线的 HTTPS 正常使用。禁止 javascript/file/data、远程 http、带凭据、Unicode/空格等范围不扩张。原始可点击地址按作者文本保留。
4. 在 Pane、实际 Client 和已接入桌面绘制位置提交前统一归一化，内容保护后的结果必须再次验证并归一化，避免保护替换制造新的不安全 Link。不修改插件原输入对象，不重复执行处理函数。最后 renderer 仍防御检查，收到不安全 Link 只显示 span；正常地址点击继续 preventDefault 并交给原 openExternal。
5. 不安全地址不生成 ui.fault，不停止 Client；真实其他错误仍按阶段15处理。宿主行为版本递增，批准不能悄悄取得改变。终端任意协议与非桌面宿主不在本工程适配范围，不伪称完整官方产品一致。

## 检视与验证

实现前两位独立方案评审；先跑红证明不安全 Link 原来使整树失败、无尾斜线原来被拒绝。共享边界覆盖嵌套节点、孩子优先、label/URL 回退、非字符串原始树、控制字符、超长、保留正常树身份及回调。

真实 QuickJS 验证构造器、Pane、Client 和已有普通绘制位置，以及内容保护把正常地址换成危险地址后仅文字化，周围按钮仍能操作且无 ui.fault。实际 React 浏览器检查危险节点不是锚点/不可聚焦、点击不调用 openExternal、HTTPS 和 localhost 照常调用；真实 Electron 安装批准后看到完整面板并点击兄弟按钮，保留截图及请求计数。邻近/冻结广域回归、Node/Web 类型、仅本阶段 lint 与实际归一化成本完成后两位最终检视，再继续停驻通知/消息输入等剩余项。

两位独立正式方案评审及最终实现检视通过。初次原版 42 项通过，补充三/四斜线的明确 authority 后最终 46 项通过；两项对应修复前反例也真实失败。冻结受控回归 376 文件、3270 项通过，实际 Electron 与原聊天流程已验证。完整结果见 mods-link-fallback-stage-2026-10-04.md，继续停驻通知阶段。
