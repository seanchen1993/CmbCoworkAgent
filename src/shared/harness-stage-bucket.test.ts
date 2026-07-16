/**
 * classifyHarnessStageBucket — stage × skill bucketing.
 *
 * Locks down the three-bucket mapping that splits project-mode work into
 * plugin-constrained / vibecoding / unattributed, plus the label/order metadata
 * the dashboard renders. The decisive signal is whether a Skill was actually
 * invoked: stage-in-progress without a Skill is vibecoding, same as post-完成
 * free output.
 */

import { describe, expect, it } from "vitest"
import {
  classifyHarnessStageBucket,
  isHarnessCodeStageNodeName,
  STAGE_BUCKET_LABELS,
  STAGE_BUCKET_ORDER,
  STAGE_DONE_LABEL,
  STAGE_IN_PROGRESS_LABEL,
  type StageBucket
} from "./harness-stage-bucket"

describe("isHarnessCodeStageNodeName", () => {
  it("recognizes localized and prefixed Code-stage labels", () => {
    for (const label of ["Code", "Dev-Code", "DEV / CODE", "Dev-代码实现", "代码开发"]) {
      expect(isHarnessCodeStageNodeName(label)).toBe(true)
    }
  })

  it("does not classify unrelated or substring-only node names as Code", () => {
    for (const label of ["Dev-行为规格", "Dev-技术设计", "Decode", "VibeCoding", ""]) {
      expect(isHarnessCodeStageNodeName(label)).toBe(false)
    }
    expect(isHarnessCodeStageNodeName(null)).toBe(false)
  })
})

describe("classifyHarnessStageBucket", () => {
  it("进行中 + skill → plugin_constrained", () => {
    expect(classifyHarnessStageBucket(STAGE_IN_PROGRESS_LABEL, true)).toBe("plugin_constrained")
  })

  it("进行中 + no skill → vibecoding (bypassed the plugin)", () => {
    expect(classifyHarnessStageBucket(STAGE_IN_PROGRESS_LABEL, false)).toBe("vibecoding")
  })

  it("已完成 → vibecoding regardless of skill", () => {
    expect(classifyHarnessStageBucket(STAGE_DONE_LABEL, true)).toBe("vibecoding")
    expect(classifyHarnessStageBucket(STAGE_DONE_LABEL, false)).toBe("vibecoding")
  })

  it("other statuses and missing status → unattributed", () => {
    for (const status of ["未开始", "阻断", "警告", "错误", "跳过", "已归档", "未知"]) {
      expect(classifyHarnessStageBucket(status, true)).toBe("unattributed")
      expect(classifyHarnessStageBucket(status, false)).toBe("unattributed")
    }
    expect(classifyHarnessStageBucket(null, true)).toBe("unattributed")
    expect(classifyHarnessStageBucket(undefined, false)).toBe("unattributed")
    expect(classifyHarnessStageBucket("", true)).toBe("unattributed")
  })

  it("trims surrounding whitespace before matching", () => {
    expect(classifyHarnessStageBucket(`  ${STAGE_IN_PROGRESS_LABEL} `, true)).toBe(
      "plugin_constrained"
    )
  })
})

describe("stage bucket metadata", () => {
  it("order covers exactly the three buckets, no dups", () => {
    const expected: StageBucket[] = ["plugin_constrained", "vibecoding", "unattributed"]
    expect([...STAGE_BUCKET_ORDER].sort()).toEqual([...expected].sort())
    expect(new Set(STAGE_BUCKET_ORDER).size).toBe(STAGE_BUCKET_ORDER.length)
  })

  it("every bucket has a non-empty label", () => {
    for (const bucket of STAGE_BUCKET_ORDER) {
      expect(STAGE_BUCKET_LABELS[bucket]?.length).toBeGreaterThan(0)
    }
  })
})
