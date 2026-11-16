import { describe, expect, it } from "vitest"
import {
  formatProjectDate,
  projectDateMillis,
  projectNaturalMonth,
  projectRangeBounds,
  projectWorkingDays
} from "./project-metric-calendar"

describe("项目工作日和 GMT+8 日期", () => {
  it("同日保留小数，7小时只用于人月换算，不把耗时7小时算一天", () => {
    expect(projectWorkingDays("2026-10-12 09:00:00", "2026-10-12 16:00:00")).toBeCloseTo(7 / 24)
    expect(projectWorkingDays("2026-10-12 00:00:00", "2026-10-12 00:00:00")).toBe(0)
  })
  it("排除放假日，保留调休周末，覆盖两年和跨年", () => {
    expect(projectWorkingDays("2026-10-01", "2026-10-08")).toBe(0)
    expect(projectWorkingDays("2026-10-10", "2026-10-11")).toBe(1)
    expect(projectWorkingDays("2026-09-20", "2026-09-21")).toBe(1)
    expect(projectWorkingDays("2027-02-05", "2027-02-14")).toBe(0)
    expect(projectWorkingDays("2027-02-14", "2027-02-15")).toBe(1)
    expect(projectWorkingDays("2026-12-31", "2027-01-04")).toBe(1)
    expect(projectWorkingDays("2026-01-01", "2028-01-01")).toBe(496)
  })
  it("缺失、非法、倒置、没有配置的年份不回退自然日", () => {
    expect(projectWorkingDays(null, "2026-10-12")).toBeNull()
    expect(projectWorkingDays("2026-02-30", "2026-03-10")).toBeNull()
    expect(projectWorkingDays("2026-10-13", "2026-10-12")).toBeNull()
    expect(projectWorkingDays("2025-12-31", "2026-01-04")).toBeNull()
    expect(projectWorkingDays("2027-12-31", "2028-01-02")).toBeNull()
  })
  it("设备时区不影响无时区企业日期；项目范围使用左闭右开边界", () => {
    expect(projectDateMillis("2026-10-12 00:00:00")).toBe(Date.parse("2026-10-11T16:00:00Z"))
    expect(formatProjectDate(Date.parse("2026-10-11T16:00:00Z"))).toBe("2026-10-12 00:00:00")
    expect(
      projectRangeBounds({ from: "2026-09-30T16:00:00Z", to: "2026-10-31T15:59:59Z" })
    ).toEqual({ gte: "2026-10-01 00:00:00", lt: "2026-11-01 00:00:00" })
    expect(projectNaturalMonth({ from: "2026-10-01", to: "2026-10-31" })).toBe("2026-10")
    expect(projectNaturalMonth({ from: "2026-10-02", to: "2026-10-31" })).toBeNull()
  })
})
