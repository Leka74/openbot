/**
 * `SlackConnector` over the Slack Web API and Socket Mode (D3.4).
 *
 * - The owner's own Slack app: a user token (`xoxp-`, what they can see; messages go out as them)
 *   and an optional app-level token (`xapp-`, Socket Mode: messages as they arrive). Both are kept in
 *   the profile's `slack.json` (0600) and never leave the brain.
 * - One connection per owner profile, made when the profile first uses Slack; at boot every profile
 *   with saved tokens connects, so an inactive profile keeps listening.
 * - People and the owner's conversations are cached (10 minutes) so text reads with names.
 * - Socket Mode: `apps.connections.open` → WebSocket; every envelope is acknowledged; Slack's
 *   `disconnect` and dropped sockets reconnect (backoff up to a minute). Message events from others
 *   (not edits, joins or the owner's own) become `events`; the owner's "Send to OpenBot" clicks
 *   (message shortcut) become `shortcuts`, answered in Slack through the click's `response_url`
 *   (anyone else's click is told it isn't theirs). So do the owner's own messages that mention the
 *   app ("@OpenBot remind me later": its bot user, known by the app id), with no note in Slack.
 */
import {
  InvalidInput,
  MAIN_PROFILE_ID,
  type OwnerProfileId,
  SLACK_DISCONNECTED,
  SLACK_SHORTCUT_CALLBACK_ID,
  SLACK_SHORTCUT_NAME,
  SLACK_USER_SCOPES,
  type SlackConnectInput,
  type SlackStatus,
  Unavailable,
} from "@openbot/contracts"
import {
  currentProfileId,
  OwnerProfiles,
  type SlackConnection,
  SlackConnector,
  type SlackConversation,
  type SlackEvent,
  type SlackMessage,
  type SlackPerson,
  type SlackShortcut,
} from "@openbot/core"
import { Duration, Effect, Layer, PubSub, RcMap, Stream } from "effect"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { describeSlackError, makeSlackApi, SCOPES, type SlackApi, SlackApiError, type SlackArgs } from "./api.ts"
import { readableText, slackText } from "./text.ts"

export interface SlackConnectorOptions {
  /** Where the tokens are kept (`DataDir.profile(id).slack`). */
  readonly file: string
  /** The profile this Slack belongs to (default: the main one); its events carry it. */
  readonly profileId?: OwnerProfileId | undefined
  /** Slack Web API base (tests: a fake Slack). */
  readonly apiUrl?: string | undefined
  readonly fetch?: typeof fetch | undefined
  /** First reconnect delay of Socket Mode (default 1 s; doubles up to a minute). */
  readonly reconnectMs?: number | undefined
}

interface Saved {
  readonly version: 1
  readonly userToken: string
  readonly appToken?: string | undefined
  readonly team: string
  readonly teamUrl: string
  readonly userId: string
  readonly userName: string
}

/** A file to attach to a message: on the brain's disk. */
interface SlackUpload {
  readonly name: string
  readonly path: string
  readonly byteSize: number
}

interface User {
  readonly id: string
  readonly name: string
  readonly handle: string
  readonly realName: string
  readonly title: string
  readonly deleted: boolean
  readonly bot: boolean
  /** A Slack app's bot user: the app's id. */
  readonly appId?: string | undefined
}

const CACHE_MS = 10 * 60_000
const MAX_PAGES = 30
/** Subtypes of message events that are someone saying something. */
const SAID = new Set(["bot_message", "file_share", "thread_broadcast", "me_message"])
const CONVERSATION_TYPES = "public_channel,private_channel,mpim,im"

const toUser = (raw: Record<string, any>): User => {
  const profile = (raw.profile ?? {}) as Record<string, any>
  const realName = String(profile.real_name || raw.real_name || "")
  return {
    id: String(raw.id),
    name: String(profile.display_name || realName || raw.name || raw.id),
    handle: String(raw.name ?? ""),
    realName,
    title: String(profile.title ?? ""),
    deleted: raw.deleted === true,
    bot: raw.is_bot === true || raw.id === "USLACKBOT",
    ...(typeof profile.api_app_id === "string" && profile.api_app_id !== "" ? { appId: profile.api_app_id } : {}),
  }
}

const readSaved = (file: string): Saved | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>
    if (parsed.version !== 1 || typeof parsed.userToken !== "string" || typeof parsed.userId !== "string")
      return undefined
    return parsed as Saved
  } catch {
    return undefined
  }
}

const writeSaved = (file: string, saved: Saved): void => {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/** `https://x.slack.com/archives/C1/p1729340000123456?thread_ts=1729340000.000100` → its parts. */
export const parseSlackLink = (
  text: string,
): { readonly channelId: string; readonly ts: string; readonly threadTs?: string } | undefined => {
  const match = /\/archives\/([A-Z0-9_]+)\/p(\d{10})(\d{6})(?:\?([^\s#]*))?/.exec(text.trim())
  if (match === null) return undefined
  const threadTs = new URLSearchParams(match[4] ?? "").get("thread_ts") ?? undefined
  return { channelId: match[1]!, ts: `${match[2]}.${match[3]}`, ...(threadTs === undefined ? {} : { threadTs }) }
}

/** Scopes only some features need: a token without them still connects (and its status says what's missing). */
const OPTIONAL_SCOPES: ReadonlySet<string> = new Set(["files:write"])

const UPLOAD_TIMEOUT_MS = 10 * 60_000

const isTs = (text: string): boolean => /^\d{10}\.\d{6}$/.test(text.trim())
const isConversationId = (text: string): boolean => /^[CDG][A-Z0-9_]{6,}$/.test(text.trim())

/** One profile's Slack. */
export const makeSlackConnector = (options: SlackConnectorOptions) =>
  Effect.gen(function* () {
    const profileId = options.profileId ?? MAIN_PROFILE_ID
    const closing = new AbortController()
    const api: SlackApi = makeSlackApi({ baseUrl: options.apiUrl, fetch: options.fetch, signal: closing.signal })
    const events = yield* PubSub.unbounded<SlackEvent>()
    const shortcuts = yield* PubSub.unbounded<SlackShortcut>()
    /** The app's id, from Socket Mode's hello. */
    let appId: string | undefined
    const statusChanges = yield* PubSub.unbounded<SlackStatus>()

    let saved = readSaved(options.file)
    let status: SlackStatus = SLACK_DISCONNECTED
    const setStatus = (next: SlackStatus) => {
      status = next
      PubSub.publishUnsafe(statusChanges, next)
    }
    /** Scopes the user token lacks (an app made from an older manifest), from Slack's `x-oauth-scopes`. */
    let missingScopes: ReadonlyArray<string> = []
    const connectedStatus = (s: Saved, live: SlackStatus["events"], problem?: string): SlackStatus => ({
      connected: true,
      team: s.team,
      teamUrl: s.teamUrl,
      userId: s.userId,
      userName: s.userName,
      events: live,
      ...(problem === undefined ? {} : { problem }),
      ...(missingScopes.length === 0 ? {} : { missingScopes }),
      ...(appId === undefined ? {} : { appId }),
    })
    const missingOf = (scopes: ReadonlyArray<string>) => SLACK_USER_SCOPES.filter((scope) => !scopes.includes(scope))
    /** Every call with the user token reports its scopes: an app updated in Slack shows here without reconnecting. */
    const noteScopes = (result: Record<string, any>): Record<string, any> => {
      const scopes = result[SCOPES] as ReadonlyArray<string> | undefined
      if (scopes === undefined) return result
      const missing = missingOf(scopes)
      if (missing.join() !== missingScopes.join()) {
        missingScopes = missing
        if (saved !== undefined && status.connected) setStatus(connectedStatus(saved, status.events, status.problem))
      }
      return result
    }
    /** A Web API call as the owner. */
    const call = (method: string, args?: SlackArgs): Promise<Record<string, any>> =>
      api.call(token(), method, args).then(noteScopes)

    // ---------------------------------------------------------------- caches

    let users = new Map<string, User>()
    let usersAt = 0
    let usersLoading: Promise<void> | undefined
    let mine = new Map<string, Record<string, any>>() // the owner's conversations
    let mineAt = 0
    let mineLoading: Promise<void> | undefined
    const infos = new Map<string, Record<string, any>>() // other conversations seen

    const resetCaches = () => {
      appId = undefined
      users = new Map()
      usersAt = 0
      mine = new Map()
      mineAt = 0
      infos.clear()
    }

    const token = (): string => {
      if (saved === undefined) throw new Unavailable({ message: "Slack isn't connected (Connect apps › Slack)." })
      return saved.userToken
    }

    const loadUsers = (): Promise<void> => {
      if (users.size > 0 && Date.now() - usersAt < CACHE_MS) return Promise.resolve()
      usersLoading ??= (async () => {
        const next = new Map<string, User>()
        let cursor: string | undefined
        let pages = 0
        do {
          const page = await call("users.list", { limit: 200, cursor })
          for (const member of (page.members ?? []) as Array<Record<string, any>>)
            next.set(String(member.id), toUser(member))
          cursor = page.response_metadata?.next_cursor || undefined
        } while (cursor !== undefined && ++pages < MAX_PAGES)
        users = next
        usersAt = Date.now()
      })().finally(() => {
        usersLoading = undefined
      })
      return usersLoading
    }

    /** Makes sure these people have names (the list, then `users.info` for strangers, e.g. Slack Connect). */
    const ensureUsers = async (ids: Iterable<string>): Promise<void> => {
      await loadUsers()
      const unknown = [...new Set(ids)].filter((id) => !users.has(id)).slice(0, 20)
      await Promise.all(
        unknown.map(async (id) => {
          try {
            const found = await call("users.info", { user: id })
            users.set(id, toUser(found.user ?? { id }))
          } catch {
            // a name we cannot get stays "someone"
          }
        }),
      )
    }

    const nameOf = (id: string | undefined): string | undefined => (id === undefined ? undefined : users.get(id)?.name)

    const loadMine = (): Promise<void> => {
      if (mine.size > 0 && Date.now() - mineAt < CACHE_MS) return Promise.resolve()
      mineLoading ??= (async () => {
        const next = new Map<string, Record<string, any>>()
        let cursor: string | undefined
        let pages = 0
        do {
          const page = await call("users.conversations", {
            types: CONVERSATION_TYPES,
            exclude_archived: true,
            limit: 200,
            cursor,
          })
          for (const channel of (page.channels ?? []) as Array<Record<string, any>>)
            next.set(String(channel.id), channel)
          cursor = page.response_metadata?.next_cursor || undefined
        } while (cursor !== undefined && ++pages < MAX_PAGES)
        mine = next
        mineAt = Date.now()
      })().finally(() => {
        mineLoading = undefined
      })
      return mineLoading
    }

    const rawConversation = async (id: string): Promise<Record<string, any>> => {
      const known = mine.get(id) ?? infos.get(id)
      if (known !== undefined) return known
      const found = (await call("conversations.info", { channel: id })).channel as Record<string, any>
      infos.set(id, found)
      return found
    }

    const channelName = (id: string): string | undefined => {
      const raw = mine.get(id) ?? infos.get(id)
      return raw === undefined || raw.is_im === true ? undefined : String(raw.name ?? "")
    }

    const groupLabel = (raw: Record<string, any>): string => {
      // "mpdm-alice--bob--carol-1": the handles of everyone in it
      const handles = String(raw.name ?? "")
        .replace(/^mpdm-/, "")
        .replace(/-\d+$/, "")
        .split("--")
      const byHandle = new Map([...users.values()].map((u) => [u.handle, u.name]))
      const names = handles
        .filter((h) => h !== "" && h !== users.get(saved?.userId ?? "")?.handle)
        .map((h) => byHandle.get(h) ?? h)
      return names.join(", ") || "a group"
    }

    const conversationOf = (raw: Record<string, any>): SlackConversation => {
      const id = String(raw.id)
      if (raw.is_im === true) return { id, kind: "dm", label: nameOf(String(raw.user)) ?? "someone" }
      if (raw.is_mpim === true) return { id, kind: "group-dm", label: groupLabel(raw) }
      const topic = String(raw.topic?.value || raw.purpose?.value || "").trim()
      return {
        id,
        kind: raw.is_private === true || raw.is_group === true ? "private" : "channel",
        label: `#${String(raw.name ?? id)}`,
        ...(topic === "" ? {} : { topic: topic.length > 200 ? `${topic.slice(0, 200)}…` : topic }),
      }
    }

    const conversation = async (id: string): Promise<SlackConversation> => {
      await loadUsers()
      const raw = await rawConversation(id)
      if (raw.is_im === true) await ensureUsers([String(raw.user)])
      return conversationOf(raw)
    }

    // ---------------------------------------------------------------- messages

    const permalinkOf = (channelId: string, ts: string, threadTs?: string): string => {
      const base = saved?.teamUrl ?? "https://slack.com/"
      const link = `${base.replace(/\/?$/, "/")}archives/${channelId}/p${ts.replace(".", "")}`
      return threadTs === undefined || threadTs === ts ? link : `${link}?thread_ts=${threadTs}&cid=${channelId}`
    }

    /** A conversation itself (where a message without a ts yet went). */
    const placeLinkOf = (channelId: string): string =>
      `${(saved?.teamUrl ?? "https://slack.com/").replace(/\/?$/, "/")}archives/${channelId}`

    const mentionedIds = (text: string): Array<string> =>
      [...text.matchAll(/<@([UW][A-Z0-9_]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!)

    const textOf = (raw: Record<string, any>): string => {
      const own = String(raw.text ?? "")
      if (own.trim() !== "") return own
      const attached = ((raw.attachments ?? []) as Array<Record<string, any>>)
        .map((a) => String(a.text || a.fallback || a.title || ""))
        .filter((t) => t.trim() !== "")
      return attached.join("\n")
    }

    const toMessages = async (
      raws: ReadonlyArray<Record<string, any>>,
      channelId: string,
    ): Promise<Array<SlackMessage>> => {
      await ensureUsers(
        raws.flatMap((raw) => [...(raw.user === undefined ? [] : [String(raw.user)]), ...mentionedIds(textOf(raw))]),
      )
      const names = { user: (id: string) => nameOf(id), channel: channelName }
      return raws.map((raw): SlackMessage => {
        const ts = String(raw.ts)
        const threadTs = raw.thread_ts === undefined ? undefined : String(raw.thread_ts)
        const user = raw.user === undefined ? undefined : String(raw.user)
        const files = ((raw.files ?? []) as Array<Record<string, any>>).map((f) => String(f.name || f.title || "file"))
        return {
          channelId,
          ts,
          ...(threadTs === undefined ? {} : { threadTs }),
          ...(typeof raw.reply_count === "number" ? { replyCount: raw.reply_count } : {}),
          ...(user === undefined ? {} : { userId: user }),
          author: nameOf(user) ?? String(raw.bot_profile?.name || raw.username || "someone"),
          text: readableText(textOf(raw), names),
          ...(files.length === 0 ? {} : { files }),
          permalink: typeof raw.permalink === "string" ? raw.permalink : permalinkOf(channelId, ts, threadTs),
        }
      })
    }

    // ---------------------------------------------------------------- people and places

    const people = (): Array<User> => [...users.values()].filter((u) => !u.deleted)

    const matchPeople = (query: string): Array<User> => {
      const q = query.trim().replace(/^@/, "").toLowerCase()
      if (q === "") return []
      const all = people()
      const exact = all.filter((u) => [u.handle, u.name, u.realName].some((n) => n.toLowerCase() === q))
      if (exact.length > 0) return exact
      return all.filter((u) => [u.handle, u.name, u.realName].some((n) => n.toLowerCase().includes(q)))
    }

    const describePerson = (u: User) => `${u.name}${u.handle === "" ? "" : ` (@${u.handle})`}`

    const onePerson = (query: string): User => {
      const found = matchPeople(query)
      if (found.length === 1) return found[0]!
      if (found.length === 0)
        throw new InvalidInput({ message: `Nobody in Slack is called "${query.trim()}" (slack_find looks people up).` })
      throw new InvalidInput({
        message: `"${query.trim()}" matches several people: ${found.slice(0, 6).map(describePerson).join(", ")}. Use their @handle.`,
      })
    }

    const openDm = async (ids: ReadonlyArray<string>): Promise<string> =>
      String((await call("conversations.open", { users: ids.join(",") })).channel?.id)

    /** Where `spec` points: a link (with its message), an id, `#name`, people, or a person. */
    const place = async (
      spec: string,
    ): Promise<{ readonly id: string; readonly ts?: string; readonly threadTs?: string }> => {
      const text = spec.trim()
      const link = parseSlackLink(text)
      if (link !== undefined)
        return { id: link.channelId, ts: link.ts, ...(link.threadTs === undefined ? {} : { threadTs: link.threadTs }) }
      if (isConversationId(text)) return { id: text }
      await Promise.all([loadUsers(), loadMine()])
      const channelNamed = (name: string) =>
        [...mine.values()].find(
          (c) => c.is_im !== true && c.is_mpim !== true && String(c.name).toLowerCase() === name.toLowerCase(),
        )
      if (text.startsWith("#")) {
        const found = channelNamed(text.slice(1))
        if (found === undefined)
          throw new InvalidInput({ message: `The owner isn't in a channel called ${text} (slack_find lists them).` })
        return { id: String(found.id) }
      }
      if (text.includes(",")) {
        const ids = text
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== "")
          .map((part) => onePerson(part).id)
        return { id: await openDm(ids.filter((id) => id !== saved?.userId)) }
      }
      if (matchPeople(text).length === 0 && channelNamed(text) !== undefined)
        return { id: String(channelNamed(text)!.id) }
      const person = onePerson(text)
      if (person.id === saved?.userId) throw new InvalidInput({ message: "That's the owner themselves." })
      return { id: await openDm([person.id]) }
    }

    const firstMessage = async (channelId: string, ts: string): Promise<SlackMessage> => {
      const replies = await call("conversations.replies", { channel: channelId, ts, limit: 1, inclusive: true })
      const raw = ((replies.messages ?? []) as Array<Record<string, any>>)[0]
      if (raw === undefined) throw new InvalidInput({ message: "That Slack thread was not found." })
      return (await toMessages([raw], channelId))[0]!
    }

    // ---------------------------------------------------------------- live events (Socket Mode)

    const reconnectMs = options.reconnectMs ?? 1_000
    let listener: { readonly stop: () => void } | undefined

    const handleEvent = async (event: Record<string, any> | undefined) => {
      const current = saved
      if (current === undefined || event === undefined || event.type !== "message") return
      if (event.subtype !== undefined && !SAID.has(String(event.subtype))) return
      if (event.hidden === true) return
      if (event.user === current.userId) {
        // the owner's own words start nothing, unless they mention the app: then it's a Send to OpenBot
        if (await mentionsApp(String(event.text ?? ""))) await forwardMention(event)
        return
      }
      const channelId = String(event.channel)
      const [where, messages] = await Promise.all([conversation(channelId), toMessages([event], channelId)])
      const text = String(event.text ?? "")
      PubSub.publishUnsafe(events, {
        profileId,
        conversation: where,
        message: messages[0]!,
        mentionsOwner: text.includes(`<@${current.userId}>`) || text.includes(`<@${current.userId}|`),
      })
    }

    /** Whether `text` mentions this app's bot user ("@OpenBot", picked from Slack's suggestions). */
    const mentionsApp = async (text: string): Promise<boolean> => {
      const ids = mentionedIds(text)
      if (ids.length === 0 || appId === undefined) return false
      await ensureUsers(ids)
      return ids.some((id) => users.get(id)?.appId === appId)
    }

    /** The owner's message that mentions the app: handled like their "Send to OpenBot" click on it, silently (nothing is posted in Slack). */
    const forwardMention = async (event: Record<string, any>) => {
      const channelId = String(event.channel)
      const [where, messages] = await Promise.all([conversation(channelId), toMessages([event], channelId)])
      PubSub.publishUnsafe(shortcuts, {
        profileId,
        via: "mention" as const,
        conversation: where,
        message: messages[0]!,
        reply: () => Effect.void,
      })
    }

    /** "Send to OpenBot" on a message: the owner's click becomes a shortcut; anyone else is told no. */
    const handleShortcut = async (payload: Record<string, any> | undefined) => {
      const current = saved
      if (
        current === undefined ||
        payload?.type !== "message_action" ||
        payload.callback_id !== SLACK_SHORTCUT_CALLBACK_ID
      )
        return
      const responseUrl = typeof payload.response_url === "string" ? payload.response_url : undefined
      const reply = (text: string): Promise<void> =>
        responseUrl === undefined
          ? Promise.resolve()
          : (options.fetch ?? fetch)(responseUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ response_type: "ephemeral", text }),
              signal: AbortSignal.timeout(10_000),
            }).then(
              () => undefined,
              (error) => console.warn("[slack] shortcut reply failed:", error),
            )
      if (payload.user?.id !== current.userId) {
        await reply(`${SLACK_SHORTCUT_NAME} belongs to ${current.userName}'s OpenBot.`)
        return
      }
      const channelId = String(payload.channel?.id ?? "")
      const [where, messages] = await Promise.all([
        conversation(channelId),
        toMessages([payload.message ?? {}], channelId),
      ])
      PubSub.publishUnsafe(shortcuts, {
        profileId,
        via: "click" as const,
        conversation: where,
        message: messages[0]!,
        reply: (text) => Effect.promise(() => reply(text)),
      })
    }

    const listen = (appToken: string, owner: Saved) => {
      let stopped = false
      let socket: WebSocket | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let attempt = 0
      const seen = new Set<string>()
      const live = (s: SlackStatus["events"], problem?: string) => {
        if (!stopped && saved === owner) setStatus(connectedStatus(owner, s, problem))
      }
      const retry = (problem?: string) => {
        if (stopped) return
        live(problem === undefined ? "connecting" : "failed", problem)
        const delay = Math.min(60_000, reconnectMs * 2 ** Math.min(attempt, 6))
        attempt++
        timer = setTimeout(start, delay)
      }
      const open = async () => {
        if (stopped) return
        let url: string
        try {
          url = String((await api.call(appToken, "apps.connections.open")).url)
        } catch (error) {
          const code = error instanceof SlackApiError ? error.code : "unreachable"
          if (code === "invalid_auth" || code === "not_authed" || code === "token_revoked") {
            live(
              "failed",
              "Slack rejected the app-level token: make a new one (Basic Information › App-Level Tokens) and connect again.",
            )
            return
          }
          return retry(`Couldn't reach Slack's live messages (${code}); trying again.`)
        }
        if (stopped) return
        const ws = new WebSocket(url)
        socket = ws
        ws.onmessage = (message) => {
          let data: Record<string, any>
          try {
            data = JSON.parse(String(message.data))
          } catch {
            return
          }
          if (data.type === "hello") {
            attempt = 0
            const id = data.connection_info?.app_id
            if (typeof id === "string" && id !== "") appId = id
            live("live")
          } else if (data.type === "disconnect") {
            ws.close()
          } else if (data.envelope_id !== undefined) {
            ws.send(JSON.stringify({ envelope_id: data.envelope_id }))
            if (data.type === "interactive") {
              const envelopeId = `envelope:${String(data.envelope_id)}`
              if (seen.has(envelopeId)) return
              seen.add(envelopeId)
              void handleShortcut(data.payload).catch((error) => console.warn("[slack] shortcut not handled:", error))
              return
            }
            if (data.type !== "events_api") return
            const eventId = String(data.payload?.event_id ?? "")
            if (eventId !== "") {
              if (seen.has(eventId)) return
              seen.add(eventId)
              if (seen.size > 1_000) seen.delete(seen.values().next().value!)
            }
            void handleEvent(data.payload?.event).catch((error) => console.warn("[slack] message not handled:", error))
          }
        }
        ws.onclose = () => {
          if (socket === ws) socket = undefined
          retry()
        }
      }
      const start = () =>
        void open().catch((error) => {
          console.warn("[slack] live messages failed:", error)
          retry("Couldn't connect to Slack's live messages; trying again.")
        })
      start()
      return {
        stop: () => {
          stopped = true
          if (timer !== undefined) clearTimeout(timer)
          socket?.close()
        },
      }
    }

    const restartListening = () => {
      listener?.stop()
      listener = undefined
      if (saved === undefined) {
        setStatus(SLACK_DISCONNECTED)
        return
      }
      if (saved.appToken === undefined) {
        setStatus(connectedStatus(saved, "off"))
        return
      }
      setStatus(connectedStatus(saved, "connecting"))
      listener = listen(saved.appToken, saved)
    }

    restartListening()
    // the saved token's scopes (the app may have been updated in Slack since)
    if (saved !== undefined) void call("auth.test").catch(() => undefined)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closing.abort()
        listener?.stop()
      }),
    )

    // ---------------------------------------------------------------- the port

    const run = <A>(work: () => Promise<A>) =>
      Effect.tryPromise({
        try: work,
        catch: (error) =>
          error instanceof InvalidInput || error instanceof Unavailable ? error : describeSlackError(error),
      })

    const connect = (input: SlackConnectInput) =>
      run(async () => {
        const userToken = input.userToken?.trim() || saved?.userToken || ""
        const appToken = input.appToken?.trim() || saved?.appToken || undefined
        if (userToken === "") throw new InvalidInput({ message: "Paste the User OAuth Token (xoxp-…)." })
        if (userToken.startsWith("xoxb-")) {
          throw new InvalidInput({
            message:
              "That's the app's bot token (xoxb-…). Paste the User OAuth Token (xoxp-…) from OAuth & Permissions.",
          })
        }
        if (!userToken.startsWith("xoxp-"))
          throw new InvalidInput({ message: "Paste the User OAuth Token: it starts with xoxp-." })
        if (appToken !== undefined && !appToken.startsWith("xapp-")) {
          throw new InvalidInput({
            message: "The app-level token starts with xapp- (Basic Information › App-Level Tokens).",
          })
        }
        let auth: Record<string, any>
        try {
          auth = await api.call(userToken, "auth.test")
        } catch (error) {
          if (error instanceof SlackApiError && (error.code === "invalid_auth" || error.code === "not_authed")) {
            throw new InvalidInput({ message: "Slack didn't accept that User OAuth Token." })
          }
          throw error
        }
        const scopes = auth[SCOPES] as ReadonlyArray<string> | undefined
        const missing = scopes === undefined ? [] : missingOf(scopes)
        const required = missing.filter((scope) => !OPTIONAL_SCOPES.has(scope))
        if (required.length > 0) {
          throw new InvalidInput({
            message: `The Slack app is missing these permissions: ${required.join(", ")}. Add them under OAuth & Permissions › User Token Scopes, reinstall the app, and paste the new token.`,
          })
        }
        if (appToken !== undefined) {
          try {
            await api.call(appToken, "apps.connections.open")
          } catch (error) {
            if (error instanceof SlackApiError && (error.code === "invalid_auth" || error.code === "not_authed")) {
              throw new InvalidInput({ message: "Slack didn't accept that app-level token." })
            }
            if (error instanceof SlackApiError && error.code === "not_allowed_token_type") {
              throw new InvalidInput({
                message: "Turn on Socket Mode for the app (Settings › Socket Mode), then connect again.",
              })
            }
            throw error
          }
        }
        const userId = String(auth.user_id)
        const me = await api
          .call(userToken, "users.info", { user: userId })
          .then((r) => toUser(r.user ?? { id: userId }))
          .catch(() => undefined)
        const next: Saved = {
          version: 1,
          userToken,
          ...(appToken === undefined ? {} : { appToken }),
          team: String(auth.team ?? "Slack"),
          teamUrl: String(auth.url ?? "https://slack.com/"),
          userId,
          userName: me?.name ?? String(auth.user ?? "you"),
        }
        writeSaved(options.file, next)
        saved = next
        resetCaches()
        missingScopes = missing
        restartListening()
        return status
      })

    const disconnect = Effect.sync(() => {
      saved = undefined
      rmSync(options.file, { force: true })
      resetCaches()
      missingScopes = []
      restartListening()
    })

    const search = (input: { readonly query: string; readonly limit: number }) =>
      run(async () => {
        const found = await call("search.messages", {
          query: input.query,
          count: input.limit,
          sort: "timestamp",
          sort_dir: "desc",
        })
        const matches = (found.messages?.matches ?? []) as Array<Record<string, any>>
        await ensureUsers(
          matches.flatMap((m) =>
            m.channel?.is_im === true && typeof m.channel?.user === "string" ? [m.channel.user] : [],
          ),
        )
        const messages = await Promise.all(
          matches.map(async (m) => {
            const channel = (m.channel ?? {}) as Record<string, any>
            const threadTs = typeof m.permalink === "string" ? parseSlackLink(m.permalink)?.threadTs : undefined
            const [message] = await toMessages(
              [{ ...m, ...(threadTs === undefined ? {} : { thread_ts: threadTs }) }],
              String(channel.id),
            )
            const where =
              channel.is_im === true
                ? `DM with ${nameOf(channel.user) ?? "someone"}`
                : channel.is_mpim === true
                  ? "a group DM"
                  : `#${String(channel.name ?? channel.id)}`
            return { ...message!, where }
          }),
        )
        return { total: Number(found.messages?.total ?? messages.length), messages }
      })

    const read = (input: {
      readonly conversation: string
      readonly thread?: string | undefined
      readonly limit: number
      readonly before?: string | undefined
    }) =>
      run(async () => {
        const target = await place(input.conversation)
        const where = await conversation(target.id)
        const thread =
          input.thread === undefined
            ? target.ts === undefined
              ? undefined
              : (target.threadTs ?? target.ts)
            : (parseSlackLink(input.thread)?.threadTs ?? parseSlackLink(input.thread)?.ts ?? input.thread)
        if (thread !== undefined) {
          if (!isTs(thread))
            throw new InvalidInput({
              message: `"${thread}" is not a Slack message ts (like 1729340000.123456) or link.`,
            })
          const page = await call("conversations.replies", { channel: target.id, ts: thread, limit: input.limit })
          const raws = (page.messages ?? []) as Array<Record<string, any>>
          return { conversation: where, messages: await toMessages(raws, target.id), more: page.has_more === true }
        }
        const page = await call("conversations.history", {
          channel: target.id,
          limit: input.limit,
          ...(input.before === undefined ? {} : { latest: input.before, inclusive: false }),
        })
        const raws = ((page.messages ?? []) as Array<Record<string, any>>).slice().reverse()
        return { conversation: where, messages: await toMessages(raws, target.id), more: page.has_more === true }
      })

    const find = (query: string) =>
      run(async () => {
        await Promise.all([loadUsers(), loadMine()])
        const q = query.trim().replace(/^[#@]/, "").toLowerCase()
        const conversations = [...mine.values()]
          .map(conversationOf)
          .filter((c) => c.label.replace(/^#/, "").toLowerCase().includes(q))
          .sort((a, b) => a.label.length - b.label.length)
          .slice(0, 15)
        const found: Array<SlackPerson> = matchPeople(q)
          .filter((u) => !u.bot)
          .slice(0, 15)
          .map((u) => ({
            id: u.id,
            name: u.name,
            ...(u.handle === "" ? {} : { handle: u.handle }),
            ...(u.title === "" ? {} : { title: u.title }),
          }))
        return { conversations, people: found }
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "Unavailable" ? error : new Unavailable({ message: error.message }),
        ),
      )

    const resolve = (input: { readonly to: string; readonly thread?: string | undefined }) =>
      run(async () => {
        const target = await place(input.to)
        const where = await conversation(target.id)
        const threadSpec =
          input.thread === undefined
            ? target.ts === undefined
              ? undefined
              : (target.threadTs ?? target.ts)
            : (parseSlackLink(input.thread)?.threadTs ?? parseSlackLink(input.thread)?.ts ?? input.thread.trim())
        if (threadSpec === undefined) return { conversation: where }
        if (!isTs(threadSpec))
          throw new InvalidInput({
            message: `"${threadSpec}" is not a Slack message ts (like 1729340000.123456) or link.`,
          })
        return { conversation: where, thread: await firstMessage(target.id, threadSpec) }
      })

    /** Uploads go to a one-time URL Slack hands out; the owner's token only goes to Slack itself. */
    const apiOrigin = new URL(options.apiUrl ?? "https://slack.com/api").origin
    const isSlackHost = (url: URL) =>
      url.origin === apiOrigin || url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")

    /** One file's bytes to Slack (`files.getUploadURLExternal`, then a POST to its upload URL): its file id. */
    const upload = async (file: SlackUpload): Promise<string> => {
      const target = await call("files.getUploadURLExternal", { filename: file.name, length: file.byteSize })
      const url = new URL(String(target.upload_url))
      const fetchImpl = options.fetch ?? fetch
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: isSlackHost(url) ? { authorization: `Bearer ${token()}` } : {},
          body: Bun.file(file.path),
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        })
      } catch (cause) {
        throw new SlackApiError(cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "unreachable")
      }
      if (!response.ok) throw new Unavailable({ message: `Slack didn't take ${file.name} (HTTP ${response.status}).` })
      return String(target.file_id)
    }

    const send = (input: {
      readonly channelId: string
      readonly text: string
      readonly threadTs?: string | undefined
      readonly files?: ReadonlyArray<SlackUpload> | undefined
    }) =>
      run(async () => {
        await loadUsers()
        const text = slackText(
          input.text,
          people().map((u) => ({ id: u.id, names: [u.name, u.realName, u.handle] })),
        )
        const files = input.files ?? []
        if (files.length === 0) {
          const posted = await call("chat.postMessage", {
            channel: input.channelId,
            text,
            ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
          })
          const ts = String(posted.ts)
          return { ts, permalink: permalinkOf(String(posted.channel ?? input.channelId), ts, input.threadTs) }
        }
        // the files share one message, with the text as its comment; Slack posts it a moment later (no ts yet)
        const ids: Array<string> = []
        for (const file of files) ids.push(await upload(file))
        await call("files.completeUploadExternal", {
          files: JSON.stringify(ids.map((id, i) => ({ id, title: files[i]!.name }))),
          channel_id: input.channelId,
          ...(text.trim() === "" ? {} : { initial_comment: text }),
          ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
        })
        return {
          permalink:
            input.threadTs === undefined ? placeLinkOf(input.channelId) : permalinkOf(input.channelId, input.threadTs),
        }
      })

    const connection: SlackConnection = {
      status: Effect.sync(() => status),
      changes: Stream.fromPubSub(statusChanges),
      connect,
      disconnect,
      search,
      read,
      find,
      resolve,
      send,
      events: Stream.fromPubSub(events),
      shortcuts: Stream.fromPubSub(shortcuts),
    }
    return connection
  })

export interface SlackConnectorsOptions extends Omit<SlackConnectorOptions, "file" | "profileId"> {
  /** Where a profile's tokens are kept (`DataDir.profile(id).slack`). */
  readonly file: (profileId: OwnerProfileId) => string
}

/** Every profile's Slack: the current profile's connection, and what arrives in any of them. */
export const makeSlackConnectors = (options: SlackConnectorsOptions) =>
  Effect.gen(function* () {
    const profiles = yield* OwnerProfiles
    const events = yield* PubSub.unbounded<SlackEvent>()
    const shortcuts = yield* PubSub.unbounded<SlackShortcut>()
    const connections = yield* RcMap.make({
      lookup: (profileId: OwnerProfileId) =>
        Effect.gen(function* () {
          const connection = yield* makeSlackConnector({ ...options, file: options.file(profileId), profileId })
          yield* connection.events.pipe(
            Stream.runForEach((event) => PubSub.publish(events, event)),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* connection.shortcuts.pipe(
            Stream.runForEach((shortcut) => PubSub.publish(shortcuts, shortcut)),
            Effect.forkScoped({ startImmediately: true }),
          )
          return connection
        }),
      // a profile's Slack stays connected until the brain stops
      idleTimeToLive: Duration.infinity,
    })
    const connectionOf = (profileId: OwnerProfileId) => Effect.scoped(RcMap.get(connections, profileId))

    for (const profile of (yield* profiles.view).profiles) {
      if (existsSync(options.file(profile.id))) yield* connectionOf(profile.id)
    }

    return SlackConnector.of({
      connection: Effect.flatMap(currentProfileId, connectionOf),
      events: Stream.fromPubSub(events),
      shortcuts: Stream.fromPubSub(shortcuts),
      forget: (profileId) => RcMap.invalidate(connections, profileId),
    })
  })

export const SlackConnectorLive = (
  options: SlackConnectorsOptions,
): Layer.Layer<SlackConnector, never, OwnerProfiles> => Layer.effect(SlackConnector, makeSlackConnectors(options))
