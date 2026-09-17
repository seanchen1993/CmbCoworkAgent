import { expect, it } from "vitest"
import type { ModCommandDescriptor } from "../types"
import { parseFunctionCommandInput } from "./command-input"

const descriptor: ModCommandDescriptor = {
  apiVersion: "cmb.mods/v2",
  command: "hello",
  modId: "function:demo",
  name: "Hello",
  digest: "digest",
  grantEpoch: 1,
  workspaceEpoch: 0,
  turnId: "functions:t"
}

it("passes plain arguments, including multiline text, without requiring JSON", () => {
  expect(parseFunctionCommandInput("/hello Alice\nBob", [descriptor])).toEqual({
    descriptor,
    args: "Alice\nBob"
  })
  expect(parseFunctionCommandInput("/hello", [descriptor])?.args).toBe("")
  expect(parseFunctionCommandInput("/hello\nAlice\nBob", [descriptor])?.args).toBe("Alice\nBob")
})
it("leaves unregistered, legacy and normal prompts to their existing handlers", () => {
  expect(parseFunctionCommandInput("/other args", [descriptor])).toBeNull()
  expect(parseFunctionCommandInput("explain /hello", [descriptor])).toBeNull()
  expect(parseFunctionCommandInput("/hello", [{ ...descriptor, apiVersion: undefined }])).toBeNull()
})
