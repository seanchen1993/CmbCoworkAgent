import { z } from "zod"

/** Profile labels are single lines; trimming is a separate commit rule, never newline repair. */
export const botProfileTitleSchema = z
  .string()
  .max(200)
  .refine((value) => !/[\r\n\u2028\u2029\0]/.test(value), "标签必须为单行文本（最多 200 字符）")
