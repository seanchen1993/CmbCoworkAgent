# 链接兼容：阶段16验证记录

导入模组后，一条不能打开的链接现在会显示为普通文字，旁边的内容和按钮仍正常使用。安全 HTTPS 无尾斜线也能点击。用户不需要额外配置，作者沿用 Link 写法；用法已经加入 mods-v2-authoring.md。

本阶段仍在 codex/mods-v2 开发，UAT 未改，宿主 module-resources-v83。桌面已支持的 Pane、实际 Client、普通绘制位置和内容保护后的最终快照使用相同处理；不宣称终端协议或未接入的 Client 绘制位置已完成。

## 与原版核对的行为

固定 2.1.289 实际原版 plugin test 最终 46 项通过，desktop/mobile 各 23 项，日志 output/mods-289-link-authority.log，原始目录见 mods-latest-289-audit-2026-10-04.md。测试明确断言 Link/Text 类型和安全地址原始 href，而非仅观察日志。

Link 构造器要求字符串；原始树里非字符串的 href 可以文字化，不能混为同一层。空地址、不支持的协议、凭据、空格、Unicode、@ 路径和三/四斜线形式显示文字。可点击的是明确的 ASCII HTTPS 或 localhost HTTP。超过 2048 字和控制字符仍拒绝，归一化后的总节点和深度也继续检查。

显示优先 children，其次 label，再次字符串地址；不把对象 stringify 给用户。正常树与兄弟按钮句柄保留，修改时复制原树。先完整检查新画面，再替换旧画面，失败新绘制不会抢先取消旧按钮。危险地址不制造组件错误通知，真正的构造器或其它树错误仍按原行为拒绝。

## 检视与当前验证

两位独立最终静态检视通过。复核及自行核对发现并修复 C0/C1 地址边界、先退休旧绘制的原子提交问题、WHATWG 自动纠正空 authority 的地址；均有修复前真实失败证据，分别为 output/mods-link-control-red.log、mods-link-atomic-red.log、mods-link-authority-red.log。初始普通 Link 两项失败证据为 mods-link-red.log。

早期 VM/绘制测试失败由夹具遗漏 Client 所属插件及 AbovePrompt 实际参数，并误把可选绘制失败回落误当成直接抛错。修正夹具后测试准确检查实际 VM 异常、真实宿主回落与 callback。浏览器初轮没有实现 Vite 的 worker 导入，使用仓库已有真实 browser-worker-plugin 修复构建夹具；不把这些早期失败算进绿色结果。

| 验证 | 实际结果 | 记录 |
| --- | --- | --- |
| 最终邻近回归 | 7 文件 161 项通过 | output/mods-link-final-adjacent.log |
| 新基础边界及实际 VM | 32 + 15 项通过，含控制、保护注入、原按钮保留 | 同一最终邻近日志 |
| 实际 React 浏览器 | 14 不安全地址、3 安全地址点击及兄弟按钮通过 | output/mods-link-browser-final.log；mods-link-browser/report.json |
| 原 Flow/Claw 浏览器 | 旧完整脚本 20 场景通过，无新 worker 默认开销 | output/mods-link-existing-flow-browser.log |
| 实际 Electron | 链接 5、组件错误 8、连续聊天 8 检查点通过；最终小补丁后链接 5 再次通过 | output/mods-link-electron.log；mods-link-final-electron.log |
| Node/Web 类型 | 通过 | output/mods-link-final-types.log |
| 本阶段 lint | 15 文件 0 错误，161 条已有警告 | output/mods-link-final-lint.json |
| 冻结受控广域 | 376 文件、3270 项通过，415.89 秒 | output/mods-link-controlled-broad.log |

实际 Electron 完成安装、批准、utility process、Pane/Client/AbovePrompt 文字化、真实按钮/本地状态、零组件故障、零新增模型请求、撤权及原输入框检查。截图 links-plain-siblings.png 和 link-evidence.json 在 output/mods-validation/e2e-link-fallback。普通构建已恢复，测试入口 out/main/mods-e2e.js 不存在。

安全链接外部调用只在浏览器测试中使用受控桥验证；真实 Electron 不启动用户外部浏览器，不能声称实际 OS 打开已验证。受控广域也不代表原全仓 npm test/lint 的存量问题已消失。

## 性能及接续

实际共享处理 400 条 Link，35 次剔除前 5 次，安全树与文字化各 30 样本；安全树中位 0.7161ms、95 分位 1.4141ms，文字化中位 0.7448ms、95 分位 1.0740ms。数据 output/mods-link-performance.json，已写入兼容矩阵。处理保持有界并保留正常树身份；不含 VM、IPC、实际绘制、系统打开或模型延迟。

继续 mods-hold-toasts-design-2026-10-04.md，两位正式方案评审正在进行。面板真正显示期间暂存临时提示，关闭后才开始实际显示时钟；随后继续 Client 其它位置、消息输入与写入等可适配项。目前没有新的框架限制结论，持续目标保持进行中。
