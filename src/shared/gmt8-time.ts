export function formatGmt8Timestamp(date = new Date()): string {
  const gmt8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const pad = (value: number): string => String(value).padStart(2, "0")
  return (
    [gmt8Date.getUTCFullYear(), pad(gmt8Date.getUTCMonth() + 1), pad(gmt8Date.getUTCDate())].join(
      "-"
    ) +
    " " +
    [
      pad(gmt8Date.getUTCHours()),
      pad(gmt8Date.getUTCMinutes()),
      pad(gmt8Date.getUTCSeconds())
    ].join(":")
  )
}
