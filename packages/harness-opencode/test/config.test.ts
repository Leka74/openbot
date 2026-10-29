import { MAIN_PROFILE_ID, OwnerProfileId } from "@openbot/contracts"
import { makeDataDir, type RenderedInstructions } from "@openbot/core"
import { describe, expect, test } from "bun:test"
import { isNotFoundError } from "../src/client.ts"
import { openCodePaths } from "../src/Driver.ts"
import {
  instructionEntries,
  mcpServerName,
  parseModel,
  parseOpenBotMcpTool,
  serverArgs,
  serverConfigContent,
  serverEnv,
  sessionGrants,
  sessionRules,
} from "../src/config.ts"
import {
  decodeForm,
  decodePermission,
  DECLINED_MESSAGE,
  formAnswer,
  formToRequest,
  permissionReply,
  permissionToRequest,
} from "../src/requests.ts"

describe("server environment (isolation recipe, D2.3)", () => {
  const base = {
    HOME: "/home/u",
    PATH: "/usr/bin",
    XDG_DATA_HOME: "/home/u/.local/share",
    OPENCODE_CONFIG: "/home/u/my.json",
    OPENCODE_CONFIG_CONTENT: '{"mcp":{}}',
    OPENCODE_SERVER_PASSWORD: "user-secret",
    UNSET: undefined,
  }

  test("adds the recipe, keeps the user's data dir, drops the user's config overrides", () => {
    const env = serverEnv({
      baseEnv: base,
      password: "pw",
      configDir: "/data/opencode-config",
      testHome: "/data/opencode/home",
      configContent: serverConfigContent({ skillsDirs: ["/data/skills-lib/skills"] }),
    })
    expect(env).toMatchObject({
      OPENCODE_PASSWORD: "pw",
      OPENCODE_CLIENT: "openbot",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_CONFIG_DIR: "/data/opencode-config",
      OPENCODE_TEST_HOME: "/data/opencode/home",
      // logins live in $XDG_DATA_HOME/opencode/opencode.db: untouched
      XDG_DATA_HOME: "/home/u/.local/share",
      HOME: "/home/u",
      PATH: "/usr/bin",
    })
    expect(env.OPENCODE_CONFIG).toBeUndefined()
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect("UNSET" in env).toBe(false)
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      skills: ["/data/skills-lib/skills"],
      snapshots: false,
      share: "disabled",
    })
  })

  test("testHome undefined keeps the user's ~/.claude and ~/.agents; extra wins", () => {
    const env = serverEnv({
      baseEnv: base,
      password: "pw",
      configDir: "/c",
      testHome: undefined,
      configContent: "{}",
      extra: { XDG_DATA_HOME: "/tmp/x" },
    })
    expect(env.OPENCODE_TEST_HOME).toBeUndefined()
    expect(env.XDG_DATA_HOME).toBe("/tmp/x")
  })

  test("serve args: stdio lifetime, random loopback port", () => {
    expect(serverArgs("/bin/opencode")).toEqual([
      "/bin/opencode",
      "serve",
      "--stdio",
      "--port",
      "0",
      "--hostname",
      "127.0.0.1",
    ])
  })
})

describe("session permission rules", () => {
  const effectOf = (
    rules: ReadonlyArray<{ action: string; resource: string; effect: string }>,
    action: string,
    resource = "*",
  ) =>
    rules
      .filter(
        (r) =>
          (r.action === action || (r.action.endsWith("*") && action.startsWith(r.action.slice(0, -1)))) &&
          (r.resource === "*" || r.resource === resource),
      )
      .at(-1)?.effect

  test("native-local: side effects ask, subagents denied, only this session's OpenBot server allowed", () => {
    const rules = sessionRules({ disableBuiltinTools: false, mcpServerNames: ["openbot-aaaaaaaaaa"] })
    expect(effectOf(rules, "shell")).toBe("ask")
    expect(effectOf(rules, "edit")).toBe("ask")
    expect(effectOf(rules, "read")).toBeUndefined() // agent default (allow; .env asks)
    expect(effectOf(rules, "subagent")).toBe("deny")
    expect(effectOf(rules, "openbot-aaaaaaaaaa_message_bot")).toBe("allow")
    expect(effectOf(rules, "openbot-bbbbbbbbbb_message_bot")).toBe("deny")
  })

  test("B1: built-ins and Code Mode denied; a session grant never re-enables them", () => {
    const rules = sessionRules({
      disableBuiltinTools: true,
      mcpServerNames: ["openbot-aaaaaaaaaa"],
      grants: sessionGrants("shell", ["ls *"]),
    })
    for (const action of [
      "shell",
      "read",
      "edit",
      "write",
      "glob",
      "grep",
      "external_directory",
      "execute",
      "subagent",
    ]) {
      expect(effectOf(rules, action)).toBe("deny")
    }
    expect(effectOf(rules, "shell", "ls *")).toBe("deny")
    expect(effectOf(rules, "openbot-aaaaaaaaaa_shell")).toBe("allow")
  })

  test("skills: only the Bot's own skills are allowed (D5.5)", () => {
    const rules = sessionRules({ disableBuiltinTools: false, mcpServerNames: [], skills: ["triage"] })
    expect(effectOf(rules, "skill", "triage")).toBe("allow")
    expect(effectOf(rules, "skill", "release-notes")).toBe("deny")
    expect(
      effectOf(sessionRules({ disableBuiltinTools: false, mcpServerNames: [], skills: [] }), "skill", "triage"),
    ).toBe("deny")
    expect(
      effectOf(sessionRules({ disableBuiltinTools: false, mcpServerNames: [] }), "skill", "triage"),
    ).toBeUndefined()
  })

  test("grants default to every resource", () => {
    expect(sessionGrants("edit", undefined)).toEqual([{ action: "edit", resource: "*", effect: "allow" }])
    expect(sessionGrants("edit", ["a", "b"]).map((r) => r.resource)).toEqual(["a", "b"])
  })
})

describe("models", () => {
  test("parseModel", () => {
    expect(parseModel("openai/gpt-5#high", undefined)).toEqual({ providerID: "openai", id: "gpt-5", variant: "high" })
    expect(parseModel("openai/gpt-5", "low")).toEqual({ providerID: "openai", id: "gpt-5", variant: "low" })
    expect(parseModel("openai/gpt-5#high", "low")).toEqual({ providerID: "openai", id: "gpt-5", variant: "high" })
    expect(parseModel("openrouter/anthropic/claude-x", undefined)).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude-x",
    })
    expect(parseModel(undefined, "high")).toBeUndefined()
    expect(parseModel("gpt-5", undefined)).toBeUndefined()
    expect(parseModel("openai/", undefined)).toBeUndefined()
  })
})

describe("MCP names", () => {
  test("per-session server names are stable, distinct and parse back to openbot", () => {
    const a = mcpServerName("bot_a:cnv_1", "openbot")
    expect(a).toMatch(/^openbot-[0-9a-f]{10}$/)
    expect(mcpServerName("bot_a:cnv_1", "openbot")).toBe(a)
    expect(mcpServerName("bot_a:cnv_2", "openbot")).not.toBe(a)
    expect(parseOpenBotMcpTool(`${a}_message_bot`)).toEqual({ server: "openbot", tool: "message_bot" })
    expect(parseOpenBotMcpTool("openbot_whoami")).toEqual({ server: "openbot", tool: "whoami" })
    expect(parseOpenBotMcpTool("shell")).toBeUndefined()
  })
})

describe("instruction entries (persona, never agent.system)", () => {
  const rendered = (sections: Partial<RenderedInstructions["sections"]>, text = "all"): RenderedInstructions => ({
    text,
    sections: { base: "", persona: "", team: "", memoryIndex: "", placement: "", ...sections },
    hash: "h",
  })

  test("one entry per non-empty section, in render order", () => {
    expect(instructionEntries(rendered({ base: " Base ", memoryIndex: "- fact", placement: "Runs here." }))).toEqual([
      { key: "openbot.base", value: "Base" },
      { key: "openbot.memory", value: "- fact" },
      { key: "openbot.placement", value: "Runs here." },
    ])
  })

  test("falls back to the full text when no section is filled", () => {
    expect(instructionEntries(rendered({}, "Everything"))).toEqual([
      { key: "openbot.instructions", value: "Everything" },
    ])
    expect(instructionEntries(rendered({}, "  "))).toEqual([])
  })

  test("keys match OpenCode's entry key pattern", () => {
    for (const { key } of instructionEntries(
      rendered({ base: "a", persona: "b", team: "c", memoryIndex: "d", placement: "e" }),
    )) {
      expect(key).toMatch(/^[a-z0-9][a-z0-9._-]*$/)
    }
  })
})

describe("approvals", () => {
  const asked = (data: Record<string, unknown>) => decodePermission({ id: "per_1", sessionID: "ses_1", ...data })!

  test("decisions map to native replies (OpenBot never sends `always`)", () => {
    expect(permissionReply({ decision: "allow-once" })).toEqual({ decision: "once", grant: false })
    expect(permissionReply({ decision: "allow-session" })).toEqual({ decision: "once", grant: true })
    expect(permissionReply({ decision: "allow-always" })).toEqual({ decision: "once", grant: true })
    expect(permissionReply({ decision: "deny" })).toEqual({
      decision: "reject",
      message: DECLINED_MESSAGE,
      grant: false,
    })
    expect(permissionReply({ decision: "deny", message: " no " })).toEqual({
      decision: "reject",
      message: "no",
      grant: false,
    })
    // a reject without a message stops the whole execution
    expect(permissionReply({ decision: "cancel" })).toEqual({ decision: "reject", grant: false })
    expect(permissionReply({ answers: {} })).toMatchObject({ decision: "reject", grant: false })
  })

  test("permission.asked → approval requests by action", () => {
    expect(decodePermission({ id: "per_1" })).toBeUndefined()
    const shell = permissionToRequest(
      asked({ action: "shell", resources: ["git push"] }),
      { name: undefined, input: undefined, key: undefined },
      { cwd: "/ws" },
    )
    expect(shell).toMatchObject({
      kind: "command-approval",
      surface: "shell",
      command: "git push",
      cwd: "/ws",
      nativeRequestId: "per_1",
    })
    const outside = permissionToRequest(asked({ action: "external_directory", resources: ["/etc/*"] }), {
      name: "read",
      input: undefined,
      key: undefined,
    })
    expect(outside).toMatchObject({ kind: "file-approval", surface: "file-read", paths: ["/etc/*"], toolName: "read" })
    const web = permissionToRequest(asked({ action: "webfetch", resources: ["https://x.dev"] }), {
      name: undefined,
      input: undefined,
      key: undefined,
    })
    expect(web).toMatchObject({ kind: "tool-approval", surface: "network" })
    const mcp = permissionToRequest(asked({ action: "openbot-0123456789_shell", resources: ["*"] }), {
      name: "openbot-0123456789_shell",
      input: { command: "ls", node: "nod_1" },
      key: "oc:tool:m:c",
    })
    expect(mcp).toMatchObject({
      kind: "mcp-approval",
      surface: "mcp",
      toolName: "openbot.shell",
      server: "openbot",
      nodeId: "nod_1",
      toolKey: "oc:tool:m:c",
    })
  })
})

describe("forms", () => {
  const form = decodeForm({
    form: {
      id: "frm_1",
      sessionID: "ses_1",
      metadata: { kind: "question" },
      fields: [
        { key: "n", type: "integer", title: "How many?" },
        { key: "ok", type: "boolean", title: "Sure?" },
        { key: "hidden", type: "string", hidden: true },
        { key: "ext", type: "external" },
        { key: "c", type: "string", options: [{ value: "r", label: "Red" }] },
      ],
    },
  })!

  test("hidden and external fields are not asked", () => {
    expect(form.fields.map((f) => f.key)).toEqual(["n", "ok", "c"])
    const request = formToRequest(form, undefined)
    expect(request.questions.map((q) => [q.id, q.allowFreeText])).toEqual([
      ["n", true],
      ["ok", false],
      ["c", false],
    ])
  })

  test("answers are converted to native values", () => {
    expect(formAnswer(form, { n: "2.6", ok: "Yes", c: "Red" })).toEqual({ n: 3, ok: true, c: "r" })
    expect(formAnswer(form, { n: "many", ok: "no" })).toEqual({ ok: false })
  })
})

describe("client errors", () => {
  test("isNotFoundError: declared tagged 404s and undeclared statuses", () => {
    expect(
      isNotFoundError(
        Object.assign(new Error("Session not found: ses_1"), {
          name: "SessionNotFoundError",
          _tag: "SessionNotFoundError",
        }),
      ),
    ).toBe(true)
    expect(
      isNotFoundError(
        Object.assign(new Error("UnexpectedStatus: 404"), { name: "ClientError", cause: { status: 404 } }),
      ),
    ).toBe(true)
    expect(
      isNotFoundError(
        Object.assign(new Error("UnexpectedStatus: 500"), { name: "ClientError", cause: { status: 500 } }),
      ),
    ).toBe(false)
    expect(isNotFoundError(new Error("boom"))).toBe(false)
    expect(isNotFoundError(undefined)).toBe(false)
  })
})

describe("skills of a profile", () => {
  test("a profile's server lists its own library: the main one's in skills-lib, the others' in profiles/<id>", () => {
    const paths = openCodePaths(makeDataDir("/data"))
    expect(paths.skillsDir(MAIN_PROFILE_ID)).toBe("/data/skills-lib/skills")
    expect(paths.skillsDir(OwnerProfileId.make("prf_demo"))).toBe("/data/profiles/prf_demo/skills-lib/skills")
  })
})
