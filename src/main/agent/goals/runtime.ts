import { GoalManager } from "./goal-manager"
import { SqlGoalStore } from "./goal-store"

/** One process-wide Goal state facade shared by desktop and managed transports. */
export const goalStore = new SqlGoalStore()
export const goalManager = new GoalManager(goalStore)
