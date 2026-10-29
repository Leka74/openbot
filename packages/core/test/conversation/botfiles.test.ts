// Bots send each other files (send_file `to`), and every file a bot receives — from another bot, a
// teammate in a group, or the owner — is copied into its workspace inbox on its host node before its
// turn (NodeFiles.upload; the fake keeps the bytes), listed in the turn text, and images reach
// harnesses that can see images.
import { describe, expect, test } from "bun:test"
import { type ConversationId, LOCAL_NODE_ID, MAIN_PROFILE_ID } from "@openbot/contracts"
import { Effect, Layer, Ref } from "effect"
import { AttachmentService, ConversationService, inProfile, Messaging, SendFileLimits } from "../../src/ports/index.ts"
import { BOT_DM_HINT } from "../../src/services/conversation/BotRunner.ts"
import { NodeFilesFake, runTest } from "../../src/testing/index.ts"
import { appLayer, createBot, eventsOf, messagesOf, send, settled, TestDriver, transcript, turnsOf } from "./helpers.ts"

const workspaceOf = (botId: string) => `/openbot-test/bots/${botId}/workspace`
const sha = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? "missing" : new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

/** A PNG header (1200×800) padded to `size` bytes. */
const png = (size = 5000) => {
  const bytes = new Uint8Array(size)
  for (let i = 24; i < size; i++) bytes[i] = (i * 7) & 0xff
  bytes.set([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0xb0, 0, 0, 3, 0x20,
  ])
  return bytes
}

const inboxRe = /\[Attachments: (inbox\/(att_\w+)\/([^ ]+)) \(([^,]+), ([^)]+)\)\]/

describe("bot → bot files", () => {
  test("DM: the file lands in the recipient's chat, it wakes, and reads it from its workspace inbox", async () => {
    const data = png()
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const messaging = yield* Messaging
        const files = yield* NodeFilesFake
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        yield* files.put(LOCAL_NODE_ID, `${workspaceOf(ada.id)}/out/diagram.png`, data)
        const results = yield* Ref.make<ReadonlyArray<unknown>>([])
        yield* driver.setBehavior(ada.id, (turn) =>
          Effect.gen(function* () {
            const sent = yield* messaging.sendFiles(turn.tool, {
              nodeId: LOCAL_NODE_ID,
              inv: { invocationId: "inv_t", botId: ada.id, runId: "r" },
              cwd: workspaceOf(ada.id),
              paths: ["out/diagram.png"],
              caption: "Here is the architecture diagram",
              to: "@bob",
            })
            yield* Ref.update(results, (all) => [...all, sent])
            yield* turn.say(`${turn.turnId}/m`, "Sent Bob the diagram.")
            yield* turn.complete()
          }).pipe(Effect.orDie, inProfile(MAIN_PROFILE_ID)),
        )
        yield* send(ada.directConversationId, "Send Bob the diagram")
        yield* settled(ada.directConversationId)
        yield* settled(bob.directConversationId)
        const handles = yield* driver.turns
        const bobTurn = handles.find((h) => h.bot.id === bob.id)!
        const match = inboxRe.exec(bobTurn.input.text)!
        return {
          ada,
          bob,
          results: yield* Ref.get(results),
          bobTurn,
          match,
          copied: yield* files.file(LOCAL_NODE_ID, `${workspaceOf(bob.id)}/${match[1]}`),
          adaEntries: yield* transcript(ada.directConversationId),
          bobEntries: yield* transcript(bob.directConversationId),
          bobTurns: yield* turnsOf(bob.directConversationId),
        }
      }),
      appLayer({ capabilities: { images: true } }),
    )
    const delivered = messagesOf(out.bobEntries).find((m) => m.attachments.length > 0)!
    expect(delivered).toMatchObject({
      author: { kind: "bot", botId: out.ada.id },
      toBotId: out.bob.id,
      text: "Here is the architecture diagram",
    })
    expect(delivered.attachments[0]).toMatchObject({
      name: "diagram.png",
      mime: "image/png",
      byteSize: data.byteLength,
      width: 1200,
      height: 800,
    })
    expect(out.results).toEqual([
      expect.objectContaining({
        destination: "direct",
        recipientBotId: out.bob.id,
        conversationId: out.bob.directConversationId,
        entryId: delivered.id,
      }),
    ])
    expect(eventsOf(out.adaEntries)).toContainEqual(
      expect.objectContaining({ type: "messaged-bot", toBotId: out.bob.id, entryId: delivered.id }),
    )
    // the file was copied into Bob's workspace and the turn text points at it
    expect(out.bobTurns.map((t) => [t.trigger, t.status])).toEqual([["bot", "completed"]])
    expect(out.bobTurn.input.text).toBe(
      `${BOT_DM_HINT}\n[Direct message from @Ada]: Here is the architecture diagram\n[Attachments: inbox/${delivered.attachments[0]!.id}/diagram.png (image/png, 5 KB)]`,
    )
    expect(sha(out.copied)).toBe(sha(data))
    // images also reach a harness that can see them (by their brain path)
    expect(out.bobTurn.input.attachments).toEqual([
      { path: `/openbot-test/attachments/${delivered.attachments[0]!.id}`, mime: "image/png", name: "diagram.png" },
    ])
  })

  test("group: a teammate's file stays in the group, wakes the recipient and is copied into its inbox", async () => {
    const data = new TextEncoder().encode("month,revenue\n2026-09,42\n")
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const messaging = yield* Messaging
        const files = yield* NodeFilesFake
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const group = (yield* (yield* ConversationService).createGroup({
          title: "Finance",
          memberBotIds: [ada.id, bob.id],
          leadBotId: ada.id,
        })).id as ConversationId
        yield* files.put(LOCAL_NODE_ID, `${workspaceOf(ada.id)}/revenue.csv`, data)
        yield* driver.setBehavior(ada.id, (turn) =>
          Effect.gen(function* () {
            yield* messaging.sendFiles(turn.tool, {
              nodeId: LOCAL_NODE_ID,
              inv: { invocationId: "inv_g", botId: ada.id, runId: "r" },
              cwd: workspaceOf(ada.id),
              paths: ["revenue.csv"],
              caption: "@Bob the numbers you asked for",
              to: "Bob",
            })
            yield* turn.say(`${turn.turnId}/m`, "Shared the CSV with Bob.")
            yield* turn.complete()
          }).pipe(Effect.orDie, inProfile(MAIN_PROFILE_ID)),
        )
        yield* send(group, "@Ada share the revenue CSV with Bob")
        yield* settled(group, 2)
        const handles = yield* driver.turns
        const bobTurn = handles.find((h) => h.bot.id === bob.id)!
        const match = inboxRe.exec(bobTurn.input.text)!
        return {
          ada,
          bob,
          group,
          bobTurn,
          match,
          copied: yield* files.file(LOCAL_NODE_ID, `${workspaceOf(bob.id)}/${match[1]}`),
          entries: yield* transcript(group),
          bobDm: yield* transcript(bob.directConversationId),
          bobTurns: (yield* turnsOf(group)).filter((t) => t.botId === bob.id),
        }
      }),
      appLayer(),
    )
    const posted = messagesOf(out.entries).find((m) => m.attachments.length > 0)!
    expect(posted).toMatchObject({
      author: { kind: "bot", botId: out.ada.id },
      addressedBotIds: [out.bob.id],
      text: "@Bob the numbers you asked for",
    })
    expect(posted.toBotId).toBeUndefined()
    expect(messagesOf(out.bobDm)).toHaveLength(0)
    // woken once (the caption's @mention does not wake Bob a second time)
    expect(out.bobTurns).toHaveLength(1)
    expect(out.bobTurn.input.text).toContain(
      `[@Ada]: @Bob the numbers you asked for [attached: revenue.csv (text/csv, 25 bytes)]`,
    )
    expect(out.match[1]).toBe(`inbox/${posted.attachments[0]!.id}/revenue.csv`)
    expect(out.match[4]).toBe("text/csv")
    expect(sha(out.copied)).toBe(sha(data))
    // not an image: only the inbox path, nothing inline
    expect(out.bobTurn.input.attachments).toEqual([])
  })

  test("owner uploads go through the same inbox; images only for harnesses that see images; over the cap: brain path", async () => {
    const run = (images: boolean, maxFileBytes?: number) =>
      runTest(
        Effect.gen(function* () {
          const driver = yield* TestDriver
          const files = yield* NodeFilesFake
          const attachments = yield* AttachmentService
          const ada = yield* createBot("Ada")
          const photo = yield* attachments.upload({ name: "photo.png", mime: "image/png", bytes: png(3000) })
          const notes = yield* attachments.upload({
            name: "notes.txt",
            mime: "text/plain",
            bytes: new TextEncoder().encode("hello"),
          })
          yield* send(ada.directConversationId, "Look at these", { attachmentIds: [photo.id, notes.id] })
          yield* settled(ada.directConversationId)
          const turn = (yield* driver.turns)[0]!
          return {
            turn,
            photo,
            notes,
            copiedPhoto: yield* files.file(LOCAL_NODE_ID, `${workspaceOf(ada.id)}/inbox/${photo.id}/photo.png`),
            copiedNotes: yield* files.file(LOCAL_NODE_ID, `${workspaceOf(ada.id)}/inbox/${notes.id}/notes.txt`),
          }
        }),
        maxFileBytes === undefined
          ? appLayer({ capabilities: { images } })
          : appLayer({ capabilities: { images } }).pipe(
              Layer.provide(Layer.succeed(SendFileLimits, { maxFileBytes, maxFiles: 10 })),
            ),
      )
    const seeing = await run(true)
    expect(seeing.turn.input.text).toBe(
      `Look at these\n[Attachments: inbox/${seeing.photo.id}/photo.png (image/png, 3 KB), inbox/${seeing.notes.id}/notes.txt (text/plain, 5 bytes)]`,
    )
    expect(seeing.copiedPhoto?.byteLength).toBe(3000)
    expect(new TextDecoder().decode(seeing.copiedNotes)).toBe("hello")
    expect(seeing.turn.input.attachments.map((a) => a.name)).toEqual(["photo.png"])
    const blind = await run(false)
    expect(blind.turn.input.attachments).toEqual([])
    const capped = await run(true, 1000)
    expect(capped.turn.input.text).toContain(
      "photo.png (image/png, 3 KB; not copied to your computer: it is larger than the 1 KB limit)",
    )
    expect(capped.copiedPhoto).toBeUndefined()
    // a file that could not be copied is still handed over by its brain path
    expect(capped.turn.input.attachments.map((a) => a.name)).toEqual(["photo.png"])
  })

  test("`to` refusals: yourself, unknown bots, groups you are not in, and the bot-messaging switch", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const messaging = yield* Messaging
        const files = yield* NodeFilesFake
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const cy = yield* createBot("Cy")
        const others = (yield* (yield* ConversationService).createGroup({
          title: "Others",
          memberBotIds: [bob.id, cy.id],
        })).id
        yield* files.put(LOCAL_NODE_ID, `${workspaceOf(ada.id)}/a.txt`, new TextEncoder().encode("a"))
        const tool = {
          claims: {
            botId: ada.id,
            conversationId: ada.directConversationId,
            sessionKey: `${ada.id}:${ada.directConversationId}`,
            toolsets: ["bot" as const],
            hostNodeId: LOCAL_NODE_ID,
            workspacePath: workspaceOf(ada.id),
            boundNodeIds: [],
          },
        }
        const sendTo = (to: string) =>
          Effect.flip(
            messaging.sendFiles(tool, {
              nodeId: LOCAL_NODE_ID,
              inv: { invocationId: "i", botId: ada.id, runId: "r" },
              cwd: workspaceOf(ada.id),
              paths: ["a.txt"],
              to,
            }),
          )
        return {
          self: yield* sendTo("Ada"),
          unknown: yield* sendTo("Zed"),
          notMember: yield* sendTo(others),
          requests: (yield* files.requests).length,
        }
      }),
      appLayer(),
    )
    expect(out.self).toMatchObject({
      _tag: "InvalidInput",
      message: "You cannot send files to yourself. Leave out `to` to send them to the owner.",
    })
    expect(out.unknown._tag).toBe("NotFound")
    expect(out.notMember).toMatchObject({
      _tag: "InvalidInput",
      message: "`to` must be a Bot or a group chat you are a member of.",
    })
    expect(out.requests).toBe(0)
    const disabled = await runTest(
      Effect.gen(function* () {
        const ada = yield* createBot("Ada")
        yield* createBot("Bob")
        const tool = {
          claims: {
            botId: ada.id,
            conversationId: ada.directConversationId,
            sessionKey: "s",
            toolsets: ["bot" as const],
            hostNodeId: LOCAL_NODE_ID,
            workspacePath: workspaceOf(ada.id),
            boundNodeIds: [],
          },
        }
        return yield* Effect.flip(
          (yield* Messaging).sendFiles(tool, {
            nodeId: LOCAL_NODE_ID,
            inv: { invocationId: "i", botId: ada.id, runId: "r" },
            paths: ["a.txt"],
            to: "Bob",
          }),
        )
      }),
      appLayer({ settings: { botMessaging: false } }),
    )
    expect(disabled).toMatchObject({ _tag: "InvalidInput", message: "Bot-to-bot messaging is turned off in Settings." })
  })
})
