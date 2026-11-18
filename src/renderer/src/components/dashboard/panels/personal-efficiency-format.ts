export const formatPersonalMetric = (value: number | null | undefined, unit = ""): string =>
  value == null
    ? "—"
    : `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${unit === "%" ? "%" : ""}`
