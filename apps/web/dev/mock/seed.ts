// DEV MOCK ONLY: seed data resembling the Grok Bot reference renders (vendor/design-refs/grok-bot):
// eight Bots in pinned tiles and the Revenue / Engineering sections, a Chief of Staff DM with a
// question card, an approval card and event lines, a failed turn (error tray), an expired approval,
// forms and secrets, a group chat, routines, memory, skills, rules, nodes and harness statuses.
import {
  type Bot,
  type BotId,
  type ConversationId,
  DEFAULT_SETTINGS,
  type EntryId,
  type NodeId,
  type RequestId,
  type RoutineId,
  type SectionId,
  type Skill,
  type SkillName,
  type Turn,
  type TurnId,
  type MemoryFactId,
} from "@openbot/contracts"
import { botAuthor, type MockBrain, OWNER, type ToolStep } from "./brain.ts"

const MIN = 60_000

interface BotSeed {
  readonly key: string
  readonly name: string
  readonly color: string
  readonly shape: string
  readonly label?: string
  readonly section?: "revenue" | "engineering"
  readonly pinned?: boolean
  readonly hidden?: boolean
  readonly harness: Bot["harness"]
  readonly instructions: string
  readonly preview: string
  readonly unread?: number
}

const BOTS: ReadonlyArray<BotSeed> = [
  { key: "chief", name: "Chief of Staff", color: "cyan", shape: "blob", label: "Ops", pinned: true, harness: { kind: "claude", model: "claude-sonnet-4-5" }, instructions: "You run my day: calendar, inbox triage, follow-ups. Keep summaries short.", preview: "Done. You're clear until the 2pm deck review." },
  { key: "sales", name: "Sales Outreach", color: "orange", shape: "cloud", label: "Sales", pinned: true, harness: { kind: "codex", model: "gpt-5.6-luna" }, instructions: "Draft and send outbound follow-ups. Never send without approval.", preview: "Done.", unread: 1 },
  { key: "inbox", name: "Inbox Manager", color: "violet", shape: "teardrop", pinned: true, harness: { kind: "opencode" }, instructions: "Sort my inbox twice a day.", preview: "Typing…" },
  { key: "scout", name: "Research Scout", color: "blue", shape: "hex", label: "Research", section: "revenue", harness: { kind: "claude", model: "claude-opus-4-1" }, instructions: "Track competitors and summarize launches weekly.", preview: "Three competitor launches this week", unread: 2 },
  { key: "expense", name: "Expense Clerk", color: "red", shape: "square", section: "revenue", harness: { kind: "fake" }, instructions: "File my expense reports.", preview: "Report filed. 9 receipts, nothing flagged" },
  { key: "release", name: "Release Engineer", color: "green", shape: "wedge", label: "Infra", section: "engineering", harness: { kind: "codex", model: "gpt-5.6-luna" }, instructions: "Cut releases, run the checklist, post release notes.", preview: "Build 2.0.21 is live on TestFlight." },
  { key: "data", name: "Data Analyst", color: "yellow", shape: "clover", label: "Data", section: "engineering", harness: { kind: "claude", model: "claude-sonnet-4-5", profileId: "hpf_work" }, instructions: "Answer data questions from the warehouse.", preview: "Retention chart is ready." },
  { key: "travel", name: "Travel Desk", color: "magenta", shape: "sparkle", harness: { kind: "fake" }, instructions: "Book travel within policy.", preview: "Flights held until Friday noon." },
  { key: "proto", name: "Old Prototype", color: "gray", shape: "tablet", hidden: true, harness: { kind: "fake" }, instructions: "", preview: "Archived." },
]

/** Library skills each seeded Bot has (D5.5); the library itself is seeded at the end. */
const SKILLS_OF: Readonly<Record<string, ReadonlyArray<string>>> = {
  chief: ["inbox-triage", "weekly-report"],
  inbox: ["inbox-triage"],
  expense: ["pdf"],
  travel: ["pdf"],
  release: ["release-checklist"],
  data: ["weekly-report"],
}

export const seed = (brain: MockBrain, now = Date.now()) => {
  const at = (minutesAgo: number, sec = 0) => now - minutesAgo * MIN + sec * 1000
  brain.roster.apply({ type: "settings.updated", settings: { ...DEFAULT_SETTINGS, ownerName: "Alex" } })
  brain.harnesses = [
    { kind: "claude", displayName: "Claude", installed: true, version: "2.1.40", auth: { state: "signed-in", label: "alex@example.com (Max)" }, account: { email: "alex@example.com", plan: "max" }, profileId: "default", profileLabel: "Default", configDir: "/home/alex/.claude", problems: [], checkedAt: now },
    { kind: "claude", displayName: "Claude", installed: true, version: "2.1.40", auth: { state: "signed-in", label: "alex@work.dev (team)" }, account: { email: "alex@work.dev", plan: "team" }, profileId: "hpf_work", profileLabel: "Work", configDir: "/home/alex/.claude-2", problems: [], checkedAt: now },
    { kind: "codex", displayName: "Codex", installed: true, version: "0.162.1", auth: { state: "signed-in", label: "ChatGPT Pro" }, problems: [], checkedAt: now },
    { kind: "opencode", displayName: "OpenCode", installed: true, version: "2.0.29", auth: { state: "unknown" }, problems: [], checkedAt: now },
    { kind: "fake", displayName: "Fake (offline demo)", installed: true, auth: { state: "signed-in" }, problems: [], checkedAt: now },
  ]
  brain.putNode({ id: "node_local" as NodeId, label: "This computer", kind: "local", status: "online", capabilities: ["fs@1", "shell@1", "pty@1", "browser@1", "desktop@1"], declaredCapabilities: ["fs@1", "shell@1", "pty@1", "browser@1", "desktop@1"], platform: "linux", hostname: "brain", roots: ["~/openbot"], version: "0.0.0", lastSeenAt: now, createdAt: at(60 * 24 * 7) })
  // a paired VPS without the desktop programs (Settings › Computers and Expense Clerk's Computer tab say what to install)
  brain.putNode({ id: "nod_vps1" as NodeId, label: "vps-1", kind: "remote", status: "online", capabilities: ["fs@1", "shell@1"], declaredCapabilities: ["fs@1", "shell@1", "pty@1"], platform: "linux", hostname: "vps-1", roots: ["/srv/openbot"], version: "0.0.0", desktopMissing: ["Xvfb", "x11vnc", "xdotool"], lastSeenAt: now, createdAt: at(60 * 24 * 3) })
  brain.desktopMissing.set("nod_vps1", ["Xvfb", "x11vnc", "xdotool"])
  // Data Analyst's screen fails to start ("Can't reach Data Analyst's screen")
  brain.desktopBroken.set("bot_data", "Can't reach the screen: Xvfb exited (display :103 is in use)")
  brain.putSection({ id: "sec_revenue" as SectionId, name: "Revenue", order: 1 })
  brain.putSection({ id: "sec_engineering" as SectionId, name: "Engineering", order: 2 })

  const ids: Record<string, { bot: BotId; conv: ConversationId }> = {}
  for (const b of BOTS) {
    const bot = `bot_${b.key}` as BotId
    const conv = `cnv_${b.key}` as ConversationId
    ids[b.key] = { bot, conv }
    brain.putBot({
      id: bot,
      name: b.name,
      ...(b.label ? { label: b.label } : {}),
      avatar: { shape: b.shape, color: b.color },
      harness: b.harness,
      hostNodeId: (b.key === "expense" ? "nod_vps1" : "node_local") as NodeId,
      boundNodeIds: [],
      instructions: b.instructions,
      directConversationId: conv,
      ...(b.section ? { sectionId: `sec_${b.section}` as SectionId } : {}),
      pinned: b.pinned ?? false,
      hidden: b.hidden ?? false,
      notify: "all",
      autonomy: "workspace",
      projectFolders: [],
      skills: (SKILLS_OF[b.key] ?? []) as ReadonlyArray<SkillName>,
      createdAt: at(60 * 24 * 7) + BOTS.indexOf(b) * MIN,
      updatedAt: at(60),
    })
    brain.memory.set(bot, { index: "", facts: [] })
    if (b.key !== "travel" && b.key !== "expense") brain.desktops.set(bot, { state: "ready", controller: "bot" })
  }

  const direct = (key: string, lastMinutesAgo: number, extra: { unread?: number; boundary?: number; context?: number } = {}) => {
    const { bot, conv } = ids[key]!
    brain.addConversation(
      {
        id: conv,
        kind: "direct",
        botId: bot,
        title: BOTS.find((b) => b.key === key)!.name,
        createdAt: at(60 * 24 * 7),
        lastActivityAt: at(lastMinutesAgo),
        unreadCount: extra.unread ?? 0,
        ...(extra.boundary !== undefined ? { unreadBoundaryAt: extra.boundary } : {}),
        hiddenFromSidebar: false,
        epoch: "e1",
        ...(extra.context ? { sessions: [{ botId: bot, active: true, contextUsage: { usedTokens: extra.context, windowTokens: 200_000 }, updatedAt: at(lastMinutesAgo) }] } : {}),
      },
      BOTS.find((b) => b.key === key)!.preview,
    )
    return { bot, conv }
  }
  const turn = (conv: ConversationId, bot: BotId, startedMinAgo: number, status: Turn["status"] = "completed", extra: Partial<Turn> = {}): TurnId => {
    const id = brain.id("trn") as TurnId
    brain.putTurn({ id, conversationId: conv, botId: bot, status, trigger: "user", startedAt: at(startedMinAgo), ...(status === "completed" || status === "failed" ? { endedAt: at(startedMinAgo, 40) } : {}), ...extra })
    return id
  }
  const steps = (conv: ConversationId, bot: BotId, turnId: TurnId, startedMinAgo: number, list: ReadonlyArray<ToolStep>) => {
    list.forEach((s, i) => {
      const e = brain.tool(conv, bot, turnId, s, at(startedMinAgo, 5 + i * 3), s.fail ? "failed" : "completed")
      brain.put({ ...e, completedAt: e.createdAt + 2000, ...(s.output ? { output: { text: s.output } } : {}), ...(s.fail ? { error: s.fail } : {}), ...(e.command ? { command: { ...e.command, exitCode: s.fail ? 1 : 0 } } : {}) })
    })
  }

  // ------------------------------------------------------------------------- Chief of Staff (DM)
  {
    const { bot, conv } = direct("chief", 3, { unread: 2, boundary: at(70, 2), context: 124_000 })
    brain.put(brain.message(conv, OWNER, "Morning. What needs me today?", at(70), { delivery: "delivered" }))
    const t1 = turn(conv, bot, 70)
    brain.put({
      id: brain.id("ent") as EntryId,
      conversationId: conv,
      revision: 0,
      createdAt: at(70, 3),
      updatedAt: at(70, 3),
      author: botAuthor(bot),
      turnId: t1,
      kind: "reasoning",
      text: "Check calendar, the deck numbers against the finance sheet, and the offsite venue holds.",
      streaming: false,
      source: "thinking",
    })
    steps(conv, bot, t1, 70, [
      { name: "Read", toolKind: "file-read", summary: "calendar/today.ics", output: "10:00 standup\n14:00 deck review" },
      { name: "Bash", toolKind: "shell", summary: "python check_deck.py finance.xlsx", command: "python check_deck.py finance.xlsx", output: "2 stale slides: 7, 12" },
      { name: "mcp__venues__list_holds", toolKind: "mcp", summary: "venues · list holds", output: "Marina House, Hillside Lodge, The Foundry" },
    ])
    brain.put(brain.message(conv, botAuthor(bot), "Two things: the deck review at 2pm, and a yes/no on the offsite venue. Everything else is handled.", at(70, 30), { turnId: t1 }))
    brain.put(brain.message(conv, botAuthor(bot), "**Deck** → numbers checked against the finance sheet · 2 stale slides flagged\n**Offsite** → 3 venues shortlisted · dates held on each", at(70, 32), { turnId: t1 }))
    brain.put(brain.event(conv, botAuthor(bot), { type: "bot-exchange", peerBotIds: [ids.scout!.bot], messageCount: 2 }, at(70, 34)))
    const q = brain.request({
      conversationId: conv,
      botId: bot,
      kind: "question",
      title: "Which venue should I hold?",
      card: {
        type: "question",
        requestId: "req_venue" as RequestId,
        questions: [{ id: "venue", prompt: "Which venue should I hold?", options: [{ label: "Marina House" }, { label: "Hillside Lodge" }, { label: "Hold all three" }], multiSelect: false, allowFreeText: true }],
      },
      capability: { type: "answers", questions: [] },
      blocking: false,
      at: at(70, 36),
    })
    brain.put(q.entry)
    brain.putRequest(q.request)
    const user2 = brain.put(brain.message(conv, OWNER, "Marina House. Book it, and send me this summary every weekday morning.", at(8), { delivery: "delivered", reactions: [{ emoji: "👍", by: botAuthor(bot) }] }))
    const t2 = turn(conv, bot, 8, "completed", { inputEntryId: user2.id })
    brain.put(brain.message(conv, botAuthor(bot), "Booked: marina house, deposit paid. Invites updated for all 40.", at(8, 20), { turnId: t2 }))
    brain.routines.set("rtn_morning", { id: "rtn_morning" as RoutineId, botId: bot, name: "Morning briefing", prompt: "Summarize what needs me today: meetings, decisions, anything blocked.", trigger: { type: "cron", schedule: "0 8 * * 1-5", timezone: "Europe/Berlin" }, enabled: true, output: "direct", createdAt: at(8), updatedAt: at(8), nextRunAt: now + 14 * 60 * MIN })
    brain.put(brain.event(conv, botAuthor(bot), { type: "routine-changed", action: "created", routineId: "rtn_morning" as RoutineId, routineName: "Morning briefing" }, at(8, 22), t2))
    brain.put(brain.message(conv, botAuthor(bot), "Done. You're clear until the 2pm deck review. Notes are in `ops/offsite.md`, and the [booking confirmation](https://example.com/booking) is in your inbox.", at(8, 30), { turnId: t2 }))
    brain.put(brain.message(conv, botAuthor(bot), "Team status:\n\n| Bot | Harness / model | Role |\n|---|---|---|\n| **@Research Scout** | Claude / Opus 5.5 | Competitor launches, weekly digest |\n| **@Release Engineer** | Codex / `gpt-6.1-sol` | Builds, TestFlight, release notes |\n| **@Data Analyst** | OpenCode | Retention and revenue charts |\n\n@Research Scout is drafting the digest; I'll ping @Release Engineer once the build is green.", at(8, 31), { turnId: t2 }))
    const t3 = turn(conv, bot, 3)
    const a = brain.request({
      conversationId: conv,
      botId: bot,
      turnId: t3,
      kind: "command-approval",
      title: "Allow Chief of Staff to run a command on your computer?",
      card: {
        type: "approval",
        requestId: "req_builds" as RequestId,
        requestKind: "command-approval",
        title: "Allow Chief of Staff to run a command on your computer?",
        summary: "Archive 14 old build folders under ~/builds.",
        command: "tar czf ~/archive/builds-2024.tgz ~/builds/2024-* && rm -rf ~/builds/2024-*",
        cwd: "~/builds",
        toolName: "Bash",
        nodeLabel: "This computer",
        suggestedRule: { surface: "shell", match: { commandPrefix: "tar czf ~/archive" } },
      },
      capability: { type: "decision", options: [{ id: "allow-once" }, { id: "allow-always" }, { id: "deny" }], allowMessage: true },
      subject: { toolName: "Bash", command: "tar czf ~/archive/builds-2024.tgz ~/builds/2024-* && rm -rf ~/builds/2024-*", cwd: "~/builds" },
      suggestedRule: { surface: "shell", match: { commandPrefix: "tar czf ~/archive" } },
      blocking: false,
      at: at(3),
    })
    brain.put(a.entry)
    brain.putRequest(a.request)
    brain.memory.set(bot, {
      index: "- [Prefers short summaries](prefers-short-summaries.md) — bullets, no preamble\n- [Offsite budget](offsite-budget.md) — €18k cap",
      facts: [
        { id: "prefers-short-summaries" as MemoryFactId, title: "Prefers short summaries", description: "bullets, no preamble", body: "Alex wants summaries as 2–4 bullets with no preamble.", updatedAt: at(60 * 24) },
        { id: "offsite-budget" as MemoryFactId, title: "Offsite budget", description: "€18k cap", body: "The Q4 offsite budget is capped at €18k including venue and catering.", updatedAt: at(60 * 30) },
      ],
    })
  }

  // ------------------------------------------------------------------------------ Sales Outreach
  {
    const { bot, conv } = direct("sales", 25, { unread: 1, boundary: at(26) })
    brain.put(brain.message(conv, OWNER, "Draft the follow-up to Globex and send it if it looks fine.", at(30), { delivery: "delivered" }))
    const t = turn(conv, bot, 30)
    steps(conv, bot, t, 30, [{ name: "mcp__gmail__search", toolKind: "mcp", summary: "gmail · thread with Globex", output: "3 messages" }])
    brain.put(brain.message(conv, botAuthor(bot), "Sent the follow-up to **Dana at Globex**:\n\n- recap of the pilot numbers\n- the pricing sheet\n- two times for a call next week", at(25, 10), { turnId: t }))
    brain.put(brain.message(conv, botAuthor(bot), "Done.", at(25, 12), { turnId: t }))
  }

  // ------------------------------------------------------------------------------- Inbox Manager
  {
    const { bot, conv } = direct("inbox", 1)
    brain.put(brain.message(conv, OWNER, "Sort the inbox and flag anything urgent.", at(2), { delivery: "delivered" }))
    const t = turn(conv, bot, 2, "running")
    steps(conv, bot, t, 2, [{ name: "mcp__gmail__list", toolKind: "mcp", summary: "gmail · 48 unread", output: "48 threads" }])
    brain.put(brain.message(conv, botAuthor(bot), "Sorting 48 unread threads now.", at(1), { turnId: t }))
    brain.setActivity(bot, "working", { conversationId: conv, label: "Typing…" })
  }

  // ------------------------------------------------------------------------------ Research Scout
  {
    const { bot, conv } = direct("scout", 40, { unread: 2, boundary: at(41) })
    brain.put(brain.message(conv, OWNER, "Anything new from competitors this week?", at(45), { delivery: "delivered" }))
    const t = turn(conv, bot, 45)
    steps(conv, bot, t, 45, [
      { name: "WebSearch", toolKind: "search", summary: "competitor launches this week" },
      { name: "WebFetch", toolKind: "web", summary: "acme.com/blog/launch-week" },
      { name: "WebFetch", toolKind: "web", summary: "globex.io/changelog", fail: "403 Forbidden" },
    ])
    brain.put(brain.message(conv, botAuthor(bot), "Three competitor launches this week:", at(40, 5), { turnId: t }))
    brain.put(brain.message(conv, botAuthor(bot), "1. **Acme** shipped team workspaces (paid tier only)\n2. **Initech** cut prices by 20%\n3. **Globex** opened a waitlist for an agent product; their changelog blocked me, so this is from their newsletter", at(40, 8), { turnId: t }))
    brain.put(brain.message(conv, botAuthor(bot), "Their changelog needs an account. If you sign in for me, I'll read the full notes.", at(40, 12), { turnId: t }))
    // request_takeover: an "Action needed" hand-off card (D1.7)
    brain.takeover(conv, bot, "Sign in to globex.io on my screen, then hand it back", at(40, 14), t)
  }

  // ------------------------------------------------- Sales Outreach <-> Research Scout (bot-to-bot)
  // A long exchange from yesterday (prospect research): Sales -> Scout lives in Scout's DM, Scout ->
  // Sales in Sales's, and each sender's DM says "Messaged ...". Enough messages to page the exchange
  // dialog (conversations.exchange).
  {
    const sales = { ...ids.sales!, name: "Sales Outreach" }
    const scout = { ...ids.scout!, name: "Research Scout" }
    let t = at(60 * 22)
    const send = (from: typeof sales, to: typeof sales, text: string) => {
      const sent = brain.put(brain.message(to.conv, botAuthor(from.bot), text, t, { toBotId: to.bot }))
      brain.put(brain.event(from.conv, botAuthor(from.bot), { type: "messaged-bot", toBotId: to.bot, toName: to.name, conversationId: to.conv, entryId: sent.id }, t + 400))
      t += 90_000
    }
    const prospects: ReadonlyArray<readonly [string, string, string]> = [
      ["Globex", "Dana Park, VP Ops", "they just opened a waitlist for an agent product"],
      ["Initech", "Sam Ortiz, Head of Finance", "their 20% price cut squeezes margins; pitch the cost savings"],
      ["Umbrella", "Priya Nair, CTO", "a new compliance team, hiring 6 roles"],
      ["Hooli", "Marcus Bell, Director of Sales", "missed Q3 targets per the earnings call"],
      ["Stark Industries", "Pepper Lin, COO", "consolidating vendors this quarter"],
      ["Wayne Enterprises", "Lucius Grant, VP Engineering", "migrating off their legacy CRM"],
      ["Soylent", "Ines Duarte, Head of Growth", "launching in three new markets"],
      ["Vandelay", "Art Kramer, Procurement Lead", "RFP for logistics tooling closes Friday"],
      ["Wonka", "Charlie Bucket, Product Lead", "a new factory tour app in beta"],
      ["Tyrell", "Rachel Tan, Chief of Staff", "reorganizing the ops team"],
      ["Cyberdyne", "Miles Dyson, R&D Director", "posted about agent tooling on LinkedIn"],
      ["Aperture", "Cave Johnson Jr., CEO", "a Series C last month"],
      ["Massive Dynamic", "Nina Sharp, EVP", "expanding the Boston office"],
      ["Oscorp", "Norman Ochs, Head of IT", "a security incident in May; lead with audit logs"],
      ["Pied Piper", "Monica Hall, Partner", "board pushing for efficiency"],
      ["Prestige Worldwide", "Brennan Huff, Founder", "just hired their first sales team"],
      ["Gringotts", "Griphook Varga, Head of Risk", "new regulation deadline in January"],
      ["Monarch", "Hank Venture, Ops Manager", "complained about manual reporting in a podcast"],
      ["Dunder Mifflin", "Jan Levinson, VP Regional Sales", "branch consolidation this fall"],
      ["Acme", "Wile Coyote, Procurement", "team workspaces launch: they need onboarding help"],
    ]
    prospects.forEach(([company, contact, hook], i) => {
      send(sales, scout, `Who should I write to at **${company}**, and what's the hook?`)
      if (i % 6 === 2) {
        send(scout, sales, `**${company}**: ${contact}.`)
        send(scout, sales, `Hook: ${hook}.`)
        send(scout, sales, "Sources are in `research/prospects.md`. Want a draft opener too?")
      } else send(scout, sales, `**${company}**: ${contact}. Hook: ${hook}.`)
    })
    send(sales, scout, "Perfect, that's the whole list. Drafting the openers now.")
  }

  // ------------------------------------------------------------------------------- Expense Clerk
  {
    const { bot, conv } = direct("expense", 60 * 5)
    brain.put(brain.message(conv, OWNER, "File last week's receipts.", at(60 * 5 + 10), { delivery: "delivered" }))
    const t = turn(conv, bot, 60 * 5 + 10)
    brain.put(brain.message(conv, botAuthor(bot), "Report filed. 9 receipts, nothing flagged.", at(60 * 5), { turnId: t }))
  }

  // ---------------------------------------------------------------------------- Release Engineer
  {
    const { bot, conv } = direct("release", 50, { context: 61_000 })
    brain.put(brain.message(conv, OWNER, "Cut the 2.0.21 release and post the notes.", at(60 * 26), { delivery: "delivered" }))
    const t0 = turn(conv, bot, 60 * 26)
    brain.put(brain.message(conv, botAuthor(bot), "On it. Running the release checklist.", at(60 * 26, 10), { turnId: t0 }))
    steps(conv, bot, t0, 60 * 26, [
      { name: "Bash", toolKind: "shell", summary: "git fetch --tags && git log v2.0.20..HEAD --oneline", command: "git fetch --tags && git log v2.0.20..HEAD --oneline", output: "a1b2c3d fix: crash on resume\n9f8e7d6 feat: offline mode" },
      { name: "Read", toolKind: "file-read", summary: "CHANGELOG.md (212 lines)" },
      { name: "Bash", toolKind: "shell", summary: "npm run build", command: "npm run build", fail: "Cannot find module 'esbuild'" },
      { name: "Bash", toolKind: "shell", summary: "npm ci && npm run build", command: "npm ci && npm run build", output: "build ok in 41s" },
      { name: "Edit", toolKind: "file-edit", summary: "CHANGELOG.md" },
    ])
    brain.put(brain.message(conv, botAuthor(bot), "Build is green after reinstalling deps. Tagging now.", at(60 * 26, 50), { turnId: t0 }))
    {
      // a hand-off the owner already finished (took over, entered the code, "I'm done")
      const q = brain.takeover(conv, bot, "Enter the App Store Connect two-factor code on my screen", at(60 * 26, 52), t0)
      const response = { type: "acknowledge", action: "done" } as const
      brain.putRequest({ ...q, status: "resolved", response, resolvedAt: at(60 * 26, 54) })
      const entry = brain.conv(conv).state.entries.get(q.cardEntryId)
      if (entry?.kind === "card") brain.put({ ...entry, state: { status: "resolved", response } })
    }
    const ex = brain.request({
      conversationId: conv,
      botId: bot,
      turnId: t0,
      kind: "command-approval",
      title: "Allow Release Engineer to push tags?",
      card: { type: "approval", requestId: "req_tags" as RequestId, requestKind: "command-approval", title: "Allow Release Engineer to push tags?", summary: "Push tag v2.0.21 to origin.", command: "git push origin v2.0.21", cwd: "~/work/app", toolName: "Bash", suggestedRule: { surface: "shell", match: { commandPrefix: "git push origin" } } },
      capability: { type: "decision", options: [{ id: "allow-once" }, { id: "allow-always" }, { id: "deny" }], allowMessage: true },
      suggestedRule: { surface: "shell", match: { commandPrefix: "git push origin" } },
      blocking: true,
      status: "expired",
      at: at(60 * 26, 55),
    })
    brain.put(ex.entry)
    brain.putRequest(ex.request)
    brain.put(brain.event(conv, { kind: "system" }, { type: "auto-decided", decision: "allowed", summary: "git push origin v2.0.21", toolName: "Bash" }, at(60 * 25)))
    brain.put(brain.message(conv, botAuthor(bot), "Build 2.0.21 is live on TestFlight.", at(60 * 25, 30)))
    brain.put(brain.event(conv, botAuthor(bot), { type: "memory-updated", botId: bot, action: "remembered", title: "Release notes go to #releases" }, at(60 * 25, 35)))
    brain.put(brain.event(conv, botAuthor(bot), { type: "skill-saved", name: "release-checklist" }, at(60 * 25, 36)))
    brain.put(brain.event(conv, botAuthor(bot), { type: "handoff", fromBotId: bot, toBotId: ids.data!.bot, toName: "Data Analyst", task: "Check crash-free sessions for 2.0.21 after 24h" }, at(60 * 25, 40)))
    brain.put(brain.event(conv, { kind: "system" }, { type: "session-changed", botId: bot, action: "compacted" }, at(60)))
    brain.put(brain.message(conv, OWNER, "Cut the 2.0.22 release and post the notes.", at(52), { delivery: "delivered" }))
    const t1 = turn(conv, bot, 52)
    brain.put(brain.message(conv, botAuthor(bot), "On it. Running the release checklist.", at(52, 10), { turnId: t1 }))
    steps(conv, bot, t1, 52, [
      { name: "Bash", toolKind: "shell", summary: "git log v2.0.21..HEAD --oneline", command: "git log v2.0.21..HEAD --oneline", output: "c0ffee1 fix: login loop" },
      { name: "Bash", toolKind: "shell", summary: "npm run build", command: "npm run build", output: "build ok in 38s" },
    ])
    brain.put(brain.message(conv, botAuthor(bot), "Build is green. Notes are posted in #releases and 2.0.22 is rolling out to 10%.", at(50), { turnId: t1 }))
    brain.skills.set("release-checklist", { name: "release-checklist" as SkillName, description: "Steps to cut and announce a release", body: "1. Fetch tags\n2. Build\n3. Tag + push\n4. Post notes to #releases", updatedAt: at(60 * 25) })
  }

  // -------------------------------------------------------------------------------- Data Analyst
  {
    const { bot, conv } = direct("data", 55)
    brain.put(brain.message(conv, OWNER, "Pull the retention chart for Q3.", at(56), { delivery: "delivered" }))
    const t = turn(conv, bot, 56, "failed", { failure: { code: "timeout", message: "The reply timed out", retryable: true } })
    steps(conv, bot, t, 56, [{ name: "Bash", toolKind: "shell", summary: "psql -f queries/cohort.sql", command: "psql -f queries/cohort.sql", fail: "connection timed out" }])
    brain.put(brain.message(conv, botAuthor(bot), "Pulling the cohort table now.", at(55, 50), { turnId: t }))
    brain.setActivity(bot, "idle")
  }

  // --------------------------------------------------------------------------------- Travel Desk
  {
    const { bot, conv } = direct("travel", 60 * 3)
    // Months of older trips (more than one snapshot holds): message search jumps into them, the chat
    // pages them in. Every tenth trip mentions a visa; one has a passport scan step.
    const cities = ["Berlin", "Tokyo", "Austin", "Zürich", "Nairobi", "Montréal", "Seoul", "Porto", "Reykjavík", "Lima", "Oslo", "Kraków"]
    for (let i = 0; i < 60; i++) {
      const city = cities[i % cities.length]!
      const start = 60 * 24 * (120 - i * 2)
      const visa = i % 10 === 3
      brain.put(brain.message(conv, OWNER, `Trip ${i + 1}: book ${city} for the ${visa ? "partner summit; check the visa rules" : "quarterly review"}, back by Friday.`, at(start), { delivery: "delivered" }))
      const t = turn(conv, bot, start)
      if (i === 23) steps(conv, bot, t, start, [{ name: "Read", toolKind: "file-read", summary: "passport-scan.pdf (2 pages)", output: "Passport valid until 2031-04-02" }])
      brain.put(brain.message(conv, botAuthor(bot), `Looking at ${city} options now.`, at(start, 20), { turnId: t }))
      brain.put(brain.message(conv, botAuthor(bot), visa ? `Booked ${city}. Heads up: the visa takes about 10 working days, so I filed it today.` : `Booked ${city}: aisle seat, hotel near the office, back Friday evening.`, at(start, 50), { turnId: t }))
      brain.put(brain.message(conv, OWNER, i % 7 === 0 ? "Thanks — make the hotel refundable please." : "Great, thanks.", at(start - 30)))
      if (i % 7 === 0) brain.put(brain.message(conv, botAuthor(bot), "Done: switched to the refundable rate (+€18/night).", at(start - 31)))
    }
    brain.put(brain.message(conv, OWNER, "Hold flights to Lisbon for the offsite, Thursday morning out.", at(60 * 3 + 5), { delivery: "delivered" }))
    const t = turn(conv, bot, 60 * 3 + 5)
    brain.put(brain.message(conv, botAuthor(bot), "Flights held until Friday noon. I need a couple of details to book.", at(60 * 3, 10), { turnId: t }))
    const form = brain.request({
      conversationId: conv,
      botId: bot,
      turnId: t,
      kind: "form",
      title: "Traveler details",
      card: {
        type: "form",
        requestId: "req_traveler" as RequestId,
        title: "Traveler details",
        description: "Needed by the airline to ticket",
        fields: [
          { key: "fullName", label: "Full name (as on passport)", type: "string", required: true },
          { key: "seat", label: "Seat", type: "select", required: false, options: [{ label: "Window" }, { label: "Aisle" }] },
          { key: "bags", label: "Checked bag", type: "boolean", required: false },
        ],
      },
      capability: { type: "form", fields: [] },
      blocking: false,
      at: at(60 * 3, 12),
    })
    brain.put(form.entry)
    brain.putRequest(form.request)
    const secret = brain.request({
      conversationId: conv,
      botId: bot,
      turnId: t,
      kind: "secret",
      title: "Frequent flyer number",
      card: { type: "secret-request", requestId: "req_ff" as RequestId, label: "Frequent flyer number", envVar: "FF_NUMBER", description: "Used once to attach miles to the booking" },
      capability: { type: "secret", label: "Frequent flyer number", envVar: "FF_NUMBER" },
      blocking: false,
      at: at(60 * 3, 14),
    })
    brain.put(secret.entry)
    brain.putRequest(secret.request)
  }

  // ------------------------------------------------------------------------------- Old Prototype
  {
    const { bot, conv } = direct("proto", 60 * 24 * 6)
    brain.put(brain.message(conv, botAuthor(bot), "Archived.", at(60 * 24 * 6)))
  }

  // ---------------------------------------------------------------------------------- group chat
  {
    const members = [ids.release!.bot, ids.data!.bot, ids.scout!.bot]
    const conv = "cnv_launch" as ConversationId
    brain.addConversation(
      { id: conv, kind: "group", memberBotIds: members, leadBotId: ids.release!.bot, namedBy: "user", title: "Launch crew", createdAt: at(60 * 24 * 2), lastActivityAt: at(35), unreadCount: 0, hiddenFromSidebar: false, epoch: "e1" },
      "Data Analyst: Crash-free sessions are at 99.3%.",
    )
    for (const m of members) brain.put(brain.event(conv, { kind: "system" }, { type: "member-added", botId: m, name: brain.bot(m)!.name }, at(60 * 24 * 2)))
    brain.put(brain.message(conv, OWNER, "@Release Engineer @Data Analyst what's left before Thursday's launch?", at(38), { delivery: "delivered", addressedBotIds: [ids.release!.bot, ids.data!.bot] }))
    const t1 = turn(conv, ids.release!.bot, 38)
    brain.put(brain.message(conv, botAuthor(ids.release!.bot), "Release side is ready: 2.0.22 is at 10% rollout, no new crashes.", at(37), { turnId: t1 }))
    brain.put(brain.message(conv, botAuthor(ids.release!.bot), "I'll go to 100% Wednesday night unless someone objects.", at(37, 5), { turnId: t1 }))
    const t2 = turn(conv, ids.data!.bot, 38)
    brain.put(brain.message(conv, botAuthor(ids.data!.bot), "Crash-free sessions are at **99.3%**. Retention for the new cohort is tracking +4% vs last release.", at(35), { turnId: t2 }))
    brain.put(brain.event(conv, botAuthor(ids.data!.bot), { type: "request-elsewhere", botId: ids.data!.bot, requestId: "req_none" as RequestId, conversationId: ids.data!.conv }, at(35, 10)))
  }

  brain.rules.set("rul_git_status", { id: "rul_git_status" as never, surface: "shell", match: { commandPrefix: "git status" }, action: "allow", note: "Read-only git", origin: "user", createdAt: at(60 * 24 * 5) })

  // skills library (D5.5): written by the owner, saved by a Bot (release-checklist, above), imported
  const skill = (name: string, description: string, body: string, minutesAgo: number, extra: Partial<Skill> = {}) =>
    brain.skills.set(name, { name: name as SkillName, description, body, updatedAt: at(minutesAgo), ...extra })
  skill(
    "weekly-report",
    "Use when asked for the weekly status report",
    "# Weekly report\n\n1. Collect last week's done tickets from Linear\n2. Group them by project, biggest first\n3. Three bullets per project at most\n4. Post it to #status on Friday by 4pm\n",
    60 * 24 * 3,
  )
  skill(
    "inbox-triage",
    "Use when sorting the inbox: label, archive, and flag what needs Alex",
    "# Inbox triage\n\n- **Needs Alex**: from a customer, the board or anything with a deadline this week\n- **FYI**: newsletters and receipts, label and archive\n- Never reply on Alex's behalf\n",
    60 * 24 * 2,
  )
  skill("meeting-notes", "Use when turning a meeting transcript into notes with decisions and action items", "# Meeting notes\n\n## Decisions\n## Action items (owner, due date)\n## Open questions\n", 60 * 30)
  const pdf = brain.previewSkill("anthropics/skills/pdf")
  skill(pdf.name, pdf.description, pdf.body, 60 * 24, {
    source: { kind: "skills.sh", id: "anthropics/skills/pdf", hash: "3f9c2e1" },
    files: pdf.files.map((f) => f.path).filter((f) => f !== "SKILL.md"),
  })
  for (const b of BOTS) {
    const id = ids[b.key]!.bot
    brain.usage.set(id, { botId: id, usage: { inputTokens: 40_000 + b.name.length * 9_000, outputTokens: 6_000 + b.name.length * 700, costUsd: Number((0.4 + b.name.length * 0.11).toFixed(2)) }, turnCount: 3 + b.name.length, lastAt: at(30) })
  }
}
