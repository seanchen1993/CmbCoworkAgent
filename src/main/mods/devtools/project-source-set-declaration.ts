import { z } from "zod"

const path = z
  .string()
  .min(1)
  .max(160)
  .refine(
    (value) => /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value),
    "controlled relative directory required"
  )
export const projectSourceSetSchema = z
  .object({
    protocol: z.literal("devclaw.project-source-set/v1"),
    title: z.string().trim().min(1).max(100),
    goal: z.string().trim().min(1).max(8000),
    project: path,
    dependencies: z.array(path).max(8)
  })
  .strict()
