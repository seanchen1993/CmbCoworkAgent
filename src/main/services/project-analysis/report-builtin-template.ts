import {
  RECOMMENDED_REPORT_TEMPLATE_ID,
  RECOMMENDED_REPORT_TEMPLATE_NAME
} from "../../../shared/project-analysis-report"
import type { SavedReportTemplate } from "./report-store"

/** Shipped with the isolated project Agent; no dependency on development output files or private templates. */
export function recommendedReportTemplate(): SavedReportTemplate {
  return {
    id: RECOMMENDED_REPORT_TEMPLATE_ID,
    name: RECOMMENDED_REPORT_TEMPLATE_NAME,
    kind: "builtin",
    createdAt: "2026-11-13T00:00:00.000Z",
    updatedAt: "2026-11-13T00:00:00.000Z",
    preferences: `面向室负责人，生成便于浏览、可离线阅读和打印的综合周报或月报。
参考风格：浅色纸张、深绿色重点色、清晰章节标题、少量指标卡片、紧凑明细表。根据数据和用户要求调整布局、顺序、篇幅与颜色，不机械照抄参考 HTML。
默认关注以下模块：
1. 本期概览：活跃项目、特性、有记录人员、主要产出；先写有证据的摘要。
2. 代码产出与采纳：AI生成和有效生成行数、Commit/Push采纳行数与采纳率、Harness/Vibe使用及产出。
3. 项目活动：本期参与项目、精益关联、活动与产出；项目分析的累计指标另行标注。
4. 成员贡献：提供完整人员明细，包含参与项目/特性、对话、代码、采纳和知识调用，不做绩效排名。
5. 活跃特性：项目、特性、查询时当前阶段、对话、代码、Harness/Vibe和知识调用；不推算阶段停留天数。
6. 知识沉淀：外部知识库存和活跃明细标明查询时近30天窗口；系统内知识调用单列为本报告周期数据。
7. 值得跟进的事项：基于项目分析列出待关注项目/特性、实际指标、判断依据和核实建议，区分事实与推测。
8. 数据口径与范围：说明统计周期、截止时间、累计口径、数据缺失；无依据的模块说明缺失或省略，不补零。
全部指标使用本次快照或查询证据。参考稿没有业务数字，所有【按本期重新撰写】都必须按本期数据重写。用户要求优先于推荐布局。`,
    layout: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>室级综合运营报告</title>
<style>
:root{--ink:#223531;--muted:#6f7873;--accent:#25584d;--line:#e3e7df}*{box-sizing:border-box}
body{margin:0;background:#f3f4ef;color:var(--ink);font:15px/1.7 system-ui,-apple-system,"PingFang SC","Microsoft Yahei",sans-serif}
main{max-width:1136px;margin:24px auto;padding:0 24px}.paper{background:#fff;border:1px solid var(--line);border-radius:18px;overflow:hidden}
header{padding:32px 40px;background:linear-gradient(120deg,#f8faf5,#f0f5ed);border-bottom:1px solid var(--line)}h1{margin:4px 0;font-size:30px}h2{margin:0 0 16px;font-size:20px}h3{margin:0;font-size:13px;font-weight:500;color:var(--muted)}
section{margin:0 40px;padding:26px 0;border-bottom:1px solid var(--line)}.meta,.note{font-size:12px;color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0}.card{padding:16px;border:1px solid var(--line);border-radius:10px}.card strong{display:block;font-size:26px;color:var(--accent)}
.table-wrap{max-width:100%;overflow:auto;border:1px solid var(--line);border-radius:9px}table{width:100%;border-collapse:collapse;font-size:13px;white-space:nowrap}th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line)}th{font-weight:500;color:var(--muted);background:#f7f8f4}.callout{padding:14px 18px;background:#eff5ef;border-left:3px solid var(--accent)}summary{cursor:pointer;color:var(--accent)}
@media(max-width:700px){main{margin:12px auto;padding:0 12px}header{padding:24px 20px}section{margin:0 20px}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}h1{font-size:24px}}
@media print{body{background:#fff}main{max-width:none;margin:0;padding:0}.paper{border:0}.cards,.card{break-inside:avoid}.table-wrap{overflow:visible}table{white-space:normal}}
</style></head><body><main><article class="paper">
<header><p class="meta">项目运营 · 综合报告</p><h1><span data-report-value="meta.room"></span> · <span data-report-value="meta.periodKind"></span></h1><p data-report-value="meta.period"></p><p class="meta">数据截至 <span data-report-value="meta.dataAsOf"></span></p></header>
<section><h2>本期概览</h2><p data-report-insight>【按本期重新撰写】</p><div class="cards">
<div class="card"><h3>活跃项目</h3><strong data-report-value="summary.projectCount"></strong></div><div class="card"><h3>活跃特性</h3><strong data-report-value="summary.featureCount"></strong></div><div class="card"><h3>本期有记录人员</h3><strong data-report-value="summary.activePeople"></strong></div><div class="card"><h3>主 Agent 对话</h3><strong data-report-value="summary.conversations"></strong></div>
</div></section>
<section><h2>代码产出与采纳</h2><div class="table-wrap"><table><thead><tr><th>AI生成行数</th><th>有效生成行数</th><th>Commit采纳行数 / 率</th><th>Push采纳行数 / 率</th><th>Harness / Vibe采纳行数</th></tr></thead><tbody><tr><td data-report-value="summary.generatedLines"></td><td data-report-value="summary.effectiveGeneratedLines"></td><td><span data-report-value="summary.adoptedLines"></span> / <span data-report-value="summary.adoptionRate"></span></td><td><span data-report-value="summary.pushedAdoptedLines"></span> / <span data-report-value="summary.pushedAdoptionRate"></span></td><td><span data-report-value="summary.harnessAdoptedLines"></span> / <span data-report-value="summary.vibeAdoptedLines"></span></td></tr></tbody></table></div><p class="note">本期生成代码截至查询时的采纳状态，采纳率分母为有效生成行数。</p></section>
<section><h2>项目活动</h2><div class="table-wrap"><table><thead><tr><th>项目</th><th>精益关联</th><th>活跃特性</th><th>对话</th><th>生成行数</th><th>Commit / Push采纳率</th></tr></thead><tbody><tr data-report-repeat="projects"><td data-report-value="name"></td><td data-report-value="lean"></td><td data-report-value="featureCount"></td><td data-report-value="conversations"></td><td data-report-value="generatedLines"></td><td><span data-report-value="adoptionRate"></span> / <span data-report-value="pushedAdoptionRate"></span></td></tr></tbody></table></div></section>
<section><h2>成员贡献明细</h2><div class="table-wrap"><table><thead><tr><th>成员</th><th>项目 / 特性</th><th>对话</th><th>生成行数</th><th>Commit / Push采纳率</th><th>知识调用</th></tr></thead><tbody><tr data-report-repeat="members"><td data-report-value="name"></td><td><span data-report-value="projectCount"></span> / <span data-report-value="featureCount"></span></td><td data-report-value="conversations"></td><td data-report-value="generatedLines"></td><td><span data-report-value="adoptionRate"></span> / <span data-report-value="pushedAdoptionRate"></span></td><td data-report-value="knowledgeReads"></td></tr></tbody></table></div></section>
<section><h2>本期活跃特性明细</h2><div class="table-wrap"><table><thead><tr><th>项目 / 特性</th><th>当前阶段</th><th>对话</th><th>生成行数</th><th>Harness / Vibe采纳行数</th><th>知识调用</th></tr></thead><tbody><tr data-report-repeat="features"><td><span data-report-value="project"></span> / <span data-report-value="name"></span></td><td data-report-value="stage"></td><td data-report-value="conversations"></td><td data-report-value="generatedLines"></td><td><span data-report-value="harnessAdoptedLines"></span> / <span data-report-value="vibeAdoptedLines"></span></td><td data-report-value="knowledgeReads"></td></tr></tbody></table></div><p class="note">阶段是查询时快照，不代表报告期末阶段。</p></section>
<section><h2>知识沉淀与调用</h2><p class="note" data-report-value="knowledge.window"></p><div class="cards"><div class="card"><h3>知识总量</h3><strong data-report-value="knowledge.total"></strong></div><div class="card"><h3>外部活跃知识 · 近30天</h3><strong data-report-value="knowledge.active"></strong></div><div class="card"><h3>本期成功知识读取</h3><strong data-report-value="knowledge.periodReads"></strong></div></div><div class="table-wrap"><table><thead><tr><th>活跃知识</th><th>发布单元</th><th>最近更新</th><th>更新人</th></tr></thead><tbody><tr data-report-repeat="knowledgeFiles"><td data-report-value="name"></td><td data-report-value="deployUnit"></td><td data-report-value="updatedAt"></td><td data-report-value="updatedBy"></td></tr></tbody></table></div><p data-report-insight>【按本期重新撰写】</p></section>
<section><h2>值得跟进的事项</h2><div class="callout" data-report-insight>【按本期重新撰写】</div></section>
<section><h2>数据口径与范围</h2><p class="note" data-report-insight>【按本期重新撰写】</p></section>
</article></main></body></html>`
  }
}
