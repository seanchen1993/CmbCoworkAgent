import type { ModObject } from "../../../shared/mods/types"
import {
  createRequestUserInputTool,
  type RequestUserInputToolContext
} from "../../agent/tools/user-input-tool"
import { requestUserInputSchema } from "../../agent/tools/user-input-schema"

/** Host-created adapter only. Uses the same native schema, wait hooks and renderer acknowledgement. */
export function functionUserInputInvoker(context: RequestUserInputToolContext) {
  return async (input: ModObject, signal: AbortSignal): Promise<string> => {
    context.abortSignal?.throwIfAborted()
    signal.throwIfAborted()
    const tool = createRequestUserInputTool({
      ...context,
      allowDeferredRenderer: false
    })
    const result = await tool.invoke(requestUserInputSchema.parse(input), { signal })
    context.abortSignal?.throwIfAborted()
    signal.throwIfAborted()
    return result
  }
}
