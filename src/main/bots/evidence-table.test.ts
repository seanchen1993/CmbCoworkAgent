import { expect, it } from "vitest"
import { evidenceTable } from "./evidence-table"

it("preserves named version and value fields without selecting or calculating an answer", () => {
  expect(evidenceTable("input.csv", "id,version,amount\r\n001,10,-2.50\r\n001,2,9.00\r\n")).toEqual(
    {
      fields: ["id", "version", "amount"],
      records: [
        { record: 1, values: { id: "001", version: "10", amount: "-2.50" } },
        { record: 2, values: { id: "001", version: "2", amount: "9.00" } }
      ]
    }
  )
})

it("retains quoted fields, multiline cells, empty values and hostile property names literally", () => {
  const view = evidenceTable("input.tsv", '__proto__\tnote\tvalue\nplain\t"two\nlines"\t\n')!
  expect(view.records[0].values).toEqual({ ["__proto__"]: "plain", note: "two\nlines", value: "" })
  expect(Object.getPrototypeOf(view.records[0].values)).toBe(Object.prototype)
})

it.each([
  ["source.txt", "id,value\nA,1"],
  ["source.csv", "id,id\nA,1"],
  ["source.csv", "id,\nA,1"],
  ["source.csv", "id,value\nA,1,2"],
  ["source.csv", 'id,value\nA,"unterminated'],
  ["source.csv", 'id,value\nA,"value"extra'],
  ["source.csv", `id,value\nA,${"a".repeat(2049)}`],
  ["source.csv", `id,value\n${"A,1\n".repeat(257)}`],
  ["source.csv", `${Array.from({ length: 65 }, (_, i) => `col${i}`).join(",")}\n`],
  ["source.csv", `${"k".repeat(128)},value\n${",1\n".repeat(100)}`],
  ["source.csv", "a".repeat(32001)]
])(
  "omits the complete auxiliary view for unsupported, malformed or oversized data",
  (name, text) => {
    expect(evidenceTable(name, text)).toBeUndefined()
  }
)
