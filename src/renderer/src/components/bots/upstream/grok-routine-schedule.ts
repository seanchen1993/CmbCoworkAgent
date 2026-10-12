// Calendar presets extracted from Grok's routines/schedule.ts serializeSchedule.
// The existing Cmb Host owns validation and occurrence calculation. See PROVENANCE.json.
export type RoutineCalendarPreset =
  | { mode: "hourly"; minute: number }
  | { mode: "daily" | "weekdays"; time: { hour: number; minute: number } }
  | { mode: "weekly"; dayOfWeek: number; time: { hour: number; minute: number } }
  | { mode: "monthly"; dayOfMonth: number; time: { hour: number; minute: number } }

export function serializeRoutineCalendar(schedule: RoutineCalendarPreset): string {
  switch (schedule.mode) {
    case "hourly":
      return `${schedule.minute} * * * *`
    case "daily":
      return `${schedule.time.minute} ${schedule.time.hour} * * *`
    case "weekdays":
      return `${schedule.time.minute} ${schedule.time.hour} * * 1-5`
    case "weekly":
      return `${schedule.time.minute} ${schedule.time.hour} * * ${schedule.dayOfWeek}`
    case "monthly":
      return `${schedule.time.minute} ${schedule.time.hour} ${schedule.dayOfMonth} * *`
  }
}
