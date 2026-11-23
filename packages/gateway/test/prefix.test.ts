// The tool list a normal Claude bot gets from the gateway (native-local on a computer with a browser
// and a screen, Slack connected, chat search on, not a background task) is part of every turn's
// fixed prompt prefix. This keeps it measured: name + description + JSON schema bytes, /4 as tokens.
// `OPENBOT_PREFIX_REPORT=1 bun test packages/gateway/test/prefix.test.ts` prints the numbers.
import { describe, expect, test } from "bun:test"
import { LOCAL_NODE_ID } from "@openbot/contracts"
import { makeClaims } from "@openbot/core/testing"
import { DefaultToolkits } from "../src/McpGateway.ts"
import { type AnyTool, MAX_DESCRIPTION_CHARS, type ToolAvailability } from "../src/tool.ts"

const availability: ToolAvailability = {
  claims: makeClaims({ toolsets: ["bot", "browser", "computer"] }),
  hostNode: { id: LOCAL_NODE_ID, label: "This computer", status: "online", capabilities: [] } as never,
  slack: true,
  botSearch: true,
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength

/** What one tool adds to the prompt (as the gateway lists it: descriptions capped). */
export const toolBytes = (tool: AnyTool<never>) => {
  const description =
    tool.description.length > MAX_DESCRIPTION_CHARS
      ? tool.description.slice(0, MAX_DESCRIPTION_CHARS)
      : tool.description
  return {
    name: tool.name,
    schema: bytes(JSON.stringify(tool.params.inputSchema)),
    total: bytes(tool.name) + bytes(description) + bytes(JSON.stringify(tool.params.inputSchema)),
  }
}

export const normalBotTools = (): ReadonlyArray<AnyTool<never>> => {
  const seen = new Set<string>()
  return (DefaultToolkits as ReadonlyArray<AnyTool<never>>).filter((tool) => {
    if (!availability.claims.toolsets.includes(tool.toolset)) return false
    if (tool.available !== undefined && !tool.available(availability)) return false
    if (seen.has(tool.name)) return false
    seen.add(tool.name)
    return true
  })
}

describe("the gateway's share of the prompt prefix", () => {
  test("update_ui does not repeat show_ui's card schema", () => {
    const sizes = normalBotTools().map(toolBytes)
    const total = sizes.reduce((sum, s) => sum + s.total, 0)
    const show = sizes.find((s) => s.name === "show_ui")!
    const update = sizes.find((s) => s.name === "update_ui")!
    if (process.env["OPENBOT_PREFIX_REPORT"] === "1") {
      for (const s of [...sizes].sort((a, b) => b.total - a.total)) {
        console.log(`${s.name.padEnd(22)} ${String(s.total).padStart(6)} B (schema ${s.schema} B)`)
      }
      console.log(`${sizes.length} tools: ${total} B ≈ ${Math.round(total / 4)} tokens`)
    }
    expect(update.schema).toBeLessThan(show.schema / 4)
  })
})
