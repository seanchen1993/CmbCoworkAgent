import { z } from "zod"
import { BOT_FILE_BYTES } from "../../shared/bot-files"
import {
  BOT_TABLE_ROWS,
  BOT_TABLE_COLUMNS,
  BOT_TABLE_CELL_CHARACTERS
} from "../../shared/bot-table-preview"

export const botTableRequest = z
  .object({
    kind: z.literal("table"),
    name: z.string().min(1).max(200),
    bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= BOT_FILE_BYTES),
    sheet: z.number().int().min(0).max(99),
    rowOffset: z.number().int().min(0).max(10_000_000),
    columnOffset: z.number().int().min(0).max(1_000_000)
  })
  .strict()

export const botTableResult = z
  .object({
    sheets: z.array(z.string().max(200)).min(1).max(100),
    sheet: z.number().int().min(0).max(99),
    rowOffset: z.number().int().nonnegative(),
    columnOffset: z.number().int().nonnegative(),
    firstRow: z.number().int().min(0).max(1_048_575),
    firstColumn: z.number().int().min(0).max(16_383),
    totalRows: z.number().int().min(0).max(10_000_000),
    totalColumns: z.number().int().min(0).max(1_000_000),
    rows: z
      .array(z.array(z.string().max(BOT_TABLE_CELL_CHARACTERS)).max(BOT_TABLE_COLUMNS))
      .max(BOT_TABLE_ROWS),
    truncated: z.boolean()
  })
  .strict()
