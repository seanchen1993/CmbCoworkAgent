# 主动 Pane 滚动 SDK

参考固定 Claude Code v2.1.278，声明头 2.1.277。提供 `await $.ui.scroll({to, in?, block?})`，返回 `{}` 或 `{deny:string}`；取消、撤权或绘制代际失效也可能拒绝 promise，调用者必须保留错误处理。当前为 **partial / bounded**，不能宣称完整 Claude UI 兼容。

## 支持范围

- `to: "start" | "end"` 需要 `in` 指定本插件 Pane id。
- `to: {key}` 可选 `in`；省略且在多个本插件 Pane 有同名控件时拒绝歧义。只支持当前已绘制、属于该插件的原生 Button/Input/Select。
- `block: "start" | "center" | "end" | "nearest"`，默认 nearest；完整可见目标不移动，高于窗口的目标显示顶部，边界由宿主夹取。
- AbovePrompt、Client/Box/Text key、`{requestId}` 转录定位和非桌面 surface 尚未开放，会明确拒绝。不会通过外层 scrollIntoView 改动 transcript/composer 或调用 focus。

## 宿主流程

renderer 实测 Pane body 的 clientHeight、scrollHeight、scrollTop、clientWidth、CSS line-height 和目标矩形。桌面 `bodyRows/contentRows/offset/by` 按实测 line-height 换算，可含小数；不是虚构的终端 cell 数。原 FunctionSession dispatcher 固定 component、requestId、origin、by 与几何，只有 offset 可以改写。字段省略保留宿主原值；添加或伪造其他字段按原可选 Hook 错误语义处理。

`next` 仅准备最终偏移。完整 Hook 链结束且没有 deny（包括空字符串）后，renderer 再核对请求 id/generation、当前几何、滚动位置和用户输入 epoch，实际修改 Pane body.scrollTop 并确认位置才回执。发送请求、Hook 自称成功及模拟 ACK 都不是 DOM 成功证据。取消、缺 ACK、挂起 Hook 的总等待最多 5 秒，每 Pane 只允许一个待处理请求；ACK 不进入等待该结果的回调队列。

`end` 在实际回执后由宿主保留一次性跟随 token。renderer 必须同时保有本生命周期的本地许可，才监听实际内容尺寸并跟随增长。用户滚轮/滚动键/其他位置变化、后续成功滚动、关闭、同 id 重开、撤权和重载会停止或移除旧许可。仅宿主 token 不能在 renderer 重载后复活跟随。ACK 等待期间的人操作也不得被其迟到响应覆盖。

原 `ui.scroll` 的 person wheel/Client 观察仍使用既有像素 value 包，避免破坏存量插件；本次没有将它谎称为上游 row/pointer 契约。这是兼容矩阵保留 partial 的原因之一。

## 验证

参数/几何、严格不可变字段、两阶段确认、后置否决、取消/重绘/超时、真实 QuickJS/FunctionSession、跟随许可竞态均有测试。真实 Electron 覆盖实际 scrollTop、真实内容增长、移开后停止、竞争滚轮、重载、撤权/关闭和原 composer 对照。最终结果见 output/mods-v2-validation 的本次报告；该功能测试不构成业务验收。
