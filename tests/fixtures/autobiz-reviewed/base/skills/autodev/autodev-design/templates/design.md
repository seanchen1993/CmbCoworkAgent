# 技术设计: [来自 proposal/specs 的标题]

来源: proposal.md + PRD.md（外部资料索引）+ specs/**/*.md + design exploration 结论 + 现有代码/项目约束
状态: 待执行
创建时间: [ISO 日期时间]

## 1. Context / 输入上下文

- **Feature:** {slug}
- **Proposal:** proposal.md
- **PRD Sources:** PRD.md#外部资料与实现约束
- **Specs:** specs/[capability]/spec.md
- **当前代码现状:** [一句话概述；逐条事实进 Code Evidence]

## 2. External Source Coverage / 外部资料覆盖

| Source ID | Related Requirement / Scenario | Design Coverage | Consumption Evidence | Status |
|-----------|--------------------------------|-----------------|----------------------|--------|
| SRC-001 | REQ-001 / SCN-001 | API-001 / D-001 | [已打开的地址/路径、版本或关键契约事实] | 已消费/阻断 |

## 3. Code Evidence / 代码探索证据

| Evidence ID | Path / Symbol | Observed Fact | Verified At |
|-------------|---------------|---------------|-------------|
| EVD-001 | [路径::符号] | [观察到的现状事实] | [commit] |

## 4. Spec Traceability / 规格追踪

| Requirement | Scenarios | Decision | Design Coverage | Evidence |
|-------------|-----------|----------|-----------------|----------|
| REQ-001 | SCN-001, SCN-002 | DEC-001/无 | API-001 / DATA-001 / D-001 | EVD-001 |

## 5. API Decisions / 接口决策

- **x-auto-no-http-api:** [true/false]
- **说明:** [无 HTTP/API 时说明原因；有 API 时说明入口和契约。]

| ID | Source Refs | Method | Path / Entry | Request | Response | Errors | Auth/Tenant/Audit | Status |
|----|-------------|--------|--------------|---------|----------|--------|-------------------|--------|
| API-001 | SRC-001/无 | [GET/POST/无] | [路径或函数入口] | [请求约束] | [响应约束] | [错误处理] | [权限/租户/审计假设] | 已确认 |

## 6. Data Decisions / 数据决策

- **x-auto-no-sql:** [true/false]
- **说明:** [无数据库变更时说明原因；有数据变更时说明表、字段、索引、迁移。]

| ID | Table/Model | Change | Fields | Index/Migration | Rollback | Status |
|----|-------------|--------|--------|-----------------|----------|--------|
| DATA-001 | [表/模型] | [新增/修改/无] | [字段和含义] | [索引/迁移] | [回滚方式] | 已确认 |

## 7. Technical Design / 技术设计

### Current State
[基于 Code Evidence 的综合描述；单条事实引用 EVD-xx，不另行复述。]

### Decisions

| ID | Decision | Rationale | Alternatives | Status |
|----|----------|-----------|--------------|--------|
| D-001 | [技术决策] | [原因] | [备选方案] | 已确认 |

### Integration Points
- [模块/文件/入口路径]

## 8. Risks / Open Questions

| ID    | Type | Description | Impact | Owner/Next Step |
|-------|------|-------------|--------|-----------------|
| R-001 | 风险/待确认/读码差异 | [描述；读码差异写明「spec/D-xx 说 X，代码是 Y（EVD-xx）」] | [影响] | [下一步] |
