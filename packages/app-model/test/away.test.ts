import { describe, expect, test } from "bun:test"
import type { BotId, HeldNotification, NotificationId } from "@openbot/contracts"
import { awayGroups } from "../src/away.ts"

const held = (id: string, at: number, botId: string | undefined, needsYou = false): HeldNotification => ({
  notification: {
    id: id as NotificationId,
    kind: needsYou ? "waiting" : "finished",
    ...(botId === undefined ? {} : { botId: botId as BotId }),
    title: id,
    body: "",
    at,
  },
  needsYou,
  ...(botId === undefined ? {} : { botName: botId }),
})

const shape = (items: ReadonlyArray<HeldNotification>) =>
  awayGroups(items).map(
    (group) => `${group.botName ?? "-"}: ${group.items.map((item) => item.notification.id).join(" ")}`,
  )

describe("awayGroups", () => {
  test("Bots that need you first, then the newest; what needs you leads its group", () => {
    expect(
      shape([
        held("a1", 1, "Ada"),
        held("b1", 2, "Bob", true),
        held("c1", 3, "Cy"),
        held("a2", 4, "Ada", true),
        held("b2", 5, "Bob"),
        held("u1", 6, undefined),
      ]),
    ).toEqual(["Ada: a2 a1", "Bob: b1 b2", "-: u1", "Cy: c1"])
  })

  test("a group knows whether it needs you", () => {
    expect(awayGroups([held("a", 1, "Ada"), held("b", 2, "Bob", true)]).map((group) => group.needsYou)).toEqual([
      true,
      false,
    ])
  })

  test("nothing held, no groups", () => {
    expect(awayGroups([])).toEqual([])
  })
})
