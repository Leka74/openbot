import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decisionText, type QueueAddInput, QueueStore, UNDO_GRACE_MS } from "../src/queue/store.ts"

const DAY = 86_400_000
const T0 = new Date(2030, 0, 15, 10, 0, 0).getTime()
const P = "prof_main"

let dir: string
let store: QueueStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "queue-"))
  store = new QueueStore(join(dir, "queue.sqlite"))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const item = (over?: Partial<QueueAddInput>): QueueAddInput => ({
  profileId: P,
  botId: "bot_ada",
  botName: "Ada",
  conversationId: "cnv_ada",
  area: "Team",
  type: "decision",
  title: "Renew the domain",
  why: "It expires next week",
  ...over,
})

describe("queue store", () => {
  test("add, rank and decide: an approval reaches the Bot after the undo grace, done tells nobody", () => {
    const a = store.add(item({ options: ["One year", "Five years"], recommendedOption: 2, key: "domain" }), T0)
    const b = store.add(item({ title: "Read the release notes", type: "fyi" }), T0)
    const c = store.add(item({ title: "Approve the launch", stakes: 3, due: "2030-01-15" }), T0)
    expect([a._tag, b._tag, c._tag]).toEqual(["added", "added", "added"])
    const state = store.state(P, T0)
    expect(state.openTotal).toBe(3)
    expect(state.items[0]!.title).toBe("Approve the launch")
    expect(state.items[0]!.reasons).toEqual(["critical", "due today"])

    store.decide({ profileId: P, ids: [a.id], action: "approve" }, T0)
    store.decide({ profileId: P, ids: [b.id], action: "skip" }, T0)
    expect(store.due(T0 + 1_000)).toEqual([]) // still undoable
    const due = store.due(T0 + UNDO_GRACE_MS)
    expect(due).toHaveLength(1)
    expect(due[0]!.option).toBe("Five years")
    expect(decisionText(due[0]!)).toContain('approved "Renew the domain" and chose: Five years')
    store.markDelivered([due[0]!.decisionId], T0 + UNDO_GRACE_MS)
    expect(store.due(T0 + 2 * UNDO_GRACE_MS)).toEqual([])
    expect(store.state(P, T0).clearedToday).toBe(2)
  })

  test("a key updates the open item; a closed one stays closed until it materially changes", () => {
    const first = store.add(item({ key: "k" }), T0)
    expect(store.add(item({ key: "k" }), T0)._tag).toBe("unchanged")
    expect(store.add(item({ key: "k", why: "It expires tomorrow" }), T0)).toEqual({
      _tag: "updated",
      id: first.id,
      revision: 2,
    })
    store.decide({ profileId: P, ids: [first.id], action: "skip" }, T0)
    expect(store.add(item({ key: "k", why: "It expires tomorrow" }), T0)).toEqual({
      _tag: "unchanged",
      id: first.id,
      closed: "done",
    })
    expect(store.add(item({ key: "k", why: "It expired" }), T0)._tag).toBe("updated")
    expect(store.state(P, T0).items.map((i) => i.revision)).toEqual([3])
  })

  test("undo brings back done items within the hour, and a decision only before it reached the Bot", () => {
    const a = store.add(item(), T0)
    store.decide({ profileId: P, ids: [a.id], action: "reject", note: "Not now" }, T0)
    expect(store.undo(P, T0 + 5_000)).toEqual({ item: a.id, count: 1 })
    expect(store.state(P, T0).openTotal).toBe(1)
    store.decide({ profileId: P, ids: [a.id], action: "reject", note: "Not now" }, T0 + 6_000)
    store.markDelivered(
      store.due(T0 + 60_000).map((d) => d.decisionId),
      T0 + 60_000,
    )
    expect(store.undo(P, T0 + 61_000)).toEqual({ item: null, count: 0 })
  })

  test("stacks group three or more of one Bot's kind; protected items stay out; clearing is one undo", () => {
    const ids = ["A", "B", "C", "D"].map(
      (t) => store.add(item({ title: t, type: "review", botId: "bot_cy", botName: "Cy" }), T0).id,
    )
    store.add(item({ title: "E", type: "review", botId: "bot_cy", botName: "Cy", blocking: true }), T0)
    const [stack] = store.state(P, T0).stacks
    expect(stack!.label).toBe("reviews from Cy")
    expect(stack!.count).toBe(4)
    expect(store.clearStack(P, stack!.sig, stack!.ids, T0)).toEqual({ cleared: 4 })
    expect(store.state(P, T0).openTotal).toBe(1)
    expect(store.undo(P, T0 + 1_000).count).toBe(4)
    expect(
      store
        .state(P, T0)
        .items.map((i) => i.id)
        .sort(),
    ).toEqual([...ids, "q5"].sort())
  })

  test("not this kind: a rule closes matching items now and on add, never protected ones; off brings them back", () => {
    const a = store.add(item({ title: "Weekly digest", type: "fyi" }), T0)
    store.add(item({ title: "Pay the invoice", due: "2030-01-16" }), T0)
    const [narrow] = store.suggest(P, { id: a.id }, T0)
    expect(narrow!.label).toBe("FYIs from Ada")
    const rule = store.addRule(P, { botId: "bot_ada" }, "bot noise", T0)
    expect(rule.filtered).toBe(1) // the invoice is due tomorrow: protected
    const again = store.add(item({ title: "Another digest", type: "fyi" }), T0)
    expect(again._tag).toBe("filtered")
    expect(store.state(P, T0).rules[0]).toMatchObject({ label: "anything from Ada", filtered: 2, on: true })
    expect(store.ruleOff(P, rule.id)).toEqual({ restored: 2 })
    expect(store.state(P, T0).openTotal).toBe(3)
  })

  test("snooze hides an item until its time; profiles don't see each other's items", () => {
    const a = store.add(item(), T0)
    store.add(item({ profileId: "prof_other", title: "Elsewhere" }), T0)
    store.decide({ profileId: P, ids: [a.id], action: "snooze", hours: 24 }, T0)
    expect(store.state(P, T0 + DAY / 2).openTotal).toBe(0)
    expect(store.state(P, T0 + DAY).openTotal).toBe(1)
    expect(store.state("prof_other", T0).items.map((i) => i.title)).toEqual(["Elsewhere"])
  })

  test("refusals: reply needs a note, several items only for done and remind, options need a pick", () => {
    const a = store.add(item({ options: ["X", "Y"] }), T0)
    const b = store.add(item({ title: "Other" }), T0)
    expect(() => store.decide({ profileId: P, ids: [a.id], action: "reply" }, T0)).toThrow("say what should change")
    expect(() => store.decide({ profileId: P, ids: [a.id, b.id], action: "approve" }, T0)).toThrow("several items")
    expect(() => store.decide({ profileId: P, ids: [a.id], action: "approve" }, T0)).toThrow("pick an option")
    expect(() => store.add(item({ options: ["X"], recommendedOption: 2 }), T0)).toThrow("between 1 and 1")
  })
})
