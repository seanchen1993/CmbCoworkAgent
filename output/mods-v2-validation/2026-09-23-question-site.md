# AskUserQuestion 渲染site验证 — 2026-09-23

基线9918875e（ui.ask独立提交），host v46，官方2.1.278对照adapted。

## 先失败再实现、代码检视

新增真实guest 7项红测MODS_UI_SITE_UNSUPPORTED，renderer缺模块红测，矩阵partial红测。
复用原schema（迁到shared，main保留重新导出），原生问题ID及选项标签/顺序固定，显示文字
可以改写。nativeQuestions由host core推导，发布的元数据不能伪造，自定义树不残留旧改写。
审查补加publication红测并修复：改写文字也经过原宿主发布过滤后才能返回renderer。

保留原生提交/跳过/选项/自由文本。自定义内容仅作112px以内补充。原handler仍从原request
构造回答，不从改写展示生成答案。图片已查看，composer和原生控件可用。

原UserInputRequestDialog有2项set-state-in-effect lint错误，HEAD stdin基线已独立确认。
本次改为按requestId重建内部状态，移除effect清空旧答案；倒计时由时间差计算，interval仅
更新时钟；wrapper保持无request时原layout清空回调。下一问题不复用上一题草稿。

## 已完成验证

- 窄测第1轮3文件63项；加入publication与原生schema邻接后5文件69项通过。
- Mods20：127文件986项通过（96.31秒、maxWorkers=4），含全部Function renderer测试及原native transport。
- Node/Web typecheck exit0；最终ESLint0 errors、67 warnings（存量runner格式为主）。
- focused Electron2：5项exit0，普通out已恢复，归档2026-09-23-question-site-artifacts。
  真实guest改写问题/说明，非法选项重排回退，custom补充高度限制；关Mods后恢复原文字，
  旧runtime拒绝迟到答案，重新提交的原model原生问答正常完成，模型工具结果不含显示改写。
- Electron1最后一项超时：测试错误地期待全局Mods关闭后旧generation继续接受答案。
  实际原有authority正确报MODS_THREAD_CONTEXT_EXPIRED；已修正验证为拒绝旧结果+新关闭对照，
  没有放宽authority/generation规则。问题文字恢复本身已通过。
- 综合Electron20：116项exit0，普通out恢复；归档2026-09-23-electron-20-artifacts。包括最终
  wrapper layout清空回调、下一题无旧选择及全套原功能对照。read baseline p95 3.5283ms、
  off3.8683ms（+9.6364%，各500样本/100预热），超过5%预算；noop1000 p959.6291ms、pending0。
  原生展示功能验证通过不等于性能门禁通过，不能用前一轮-7.2%覆盖本轮超预算。

## 差异与未完成

本工程request_user_input schema与upstream不同；native answer identity及label不可改，
custom render只补充，不替代native表单。metadataSource不补造。无终端ToolProgress或非Pane Client；
ui.notice另行实现。不是业务验收；正式性能门禁此前五轮失败仍未解决，不能用单轮覆盖。
