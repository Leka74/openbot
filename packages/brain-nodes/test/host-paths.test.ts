// Project folders on the local computer: HOME / git repo roots (HostPathsLive) and the local node's
// extra path-policy roots kept current from every profile's roster (projectFolderRoots).
import { afterAll, describe, expect, test } from "bun:test"
import type {
  Bot,
  BotId,
  KnownRosterStreamItem,
  NodeId,
  OwnerProfile,
  OwnerProfileId,
  OwnerProfilesView,
} from "@openbot/contracts"
import { DEFAULT_SETTINGS, MAIN_PROFILE_ID } from "@openbot/contracts"
import { HostPaths, LiveHub, OwnerProfiles } from "@openbot/core"
import { makeBot, OTHER_PROFILE } from "@openbot/core/testing"
import { Effect, Layer, Queue, Stream } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { gitRootOf, HostPathsLive, localHome, localProjectRoots, projectFolderRoots } from "../src/index.ts"
import { tempDir } from "./helpers.ts"

const t = tempDir()
afterAll(t.cleanup)
const cursor = { epoch: "r", sequence: 0 }
const LATER_PROFILE = "prf_later" as OwnerProfileId

describe("HostPathsLive", () => {
  const repo = path.join(t.path, "projects", "snip")
  const worktree = path.join(t.path, "projects", "wt")
  mkdirSync(path.join(repo, ".git"), { recursive: true })
  mkdirSync(path.join(repo, "src", "deep"), { recursive: true })
  mkdirSync(worktree, { recursive: true })
  writeFileSync(path.join(worktree, ".git"), "gitdir: /elsewhere")
  mkdirSync(path.join(t.path, "plain", "dir"), { recursive: true })

  test("git root: the nearest ancestor with .git (dir or worktree file), else undefined", () => {
    expect(gitRootOf(path.join(repo, "src", "deep"))).toBe(repo)
    expect(gitRootOf(repo)).toBe(repo)
    expect(gitRootOf(worktree)).toBe(worktree)
    // the temp dir is not inside a repository on CI machines; when it is, the answer is above `t.path`
    const plain = gitRootOf(path.join(t.path, "plain", "dir"))
    expect(plain === undefined || !plain.startsWith(t.path)).toBe(true)
  })

  test("the local node answers home and repo roots; remote nodes answer nothing", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* HostPaths
        return {
          home: host.home("node_local" as NodeId),
          remoteHome: host.home("nod_mac" as NodeId),
          root: yield* host.projectRoot("node_local" as NodeId, path.join(repo, "src")),
          remoteRoot: yield* host.projectRoot("nod_mac" as NodeId, path.join(repo, "src")),
        }
      }).pipe(Effect.provide(HostPathsLive)),
    )
    expect(out).toEqual({ home: localHome(), remoteHome: undefined, root: repo, remoteRoot: undefined })
  })

  test("localProjectRoots: `~` expanded, invalid / duplicate / whole-home entries dropped", () => {
    expect(
      localProjectRoots(["~/projects", "/srv/code/", "/srv/code", "/", "relative", "~", "/home/me"], "/home/me"),
    ).toEqual(["/home/me/projects", "/srv/code"])
  })
})

describe("projectFolderRoots (the local node's extra roots)", () => {
  const ada = makeBot({ id: "bot_ada" as BotId, projectFolders: ["/srv/snip"] })
  const bo = makeBot({ id: "bot_bo" as BotId })
  const cy = makeBot({ id: "bot_cy" as BotId, ownerProfileId: OTHER_PROFILE, projectFolders: ["/srv/cy"] })
  const dee = makeBot({ id: "bot_dee" as BotId, ownerProfileId: LATER_PROFILE })
  const profile = (id: OwnerProfileId): OwnerProfile => ({ id, name: id, createdAt: 0 })
  const snapshot = (bots: ReadonlyArray<Bot>, sharedProjectFolders: ReadonlyArray<string>): KnownRosterStreamItem => ({
    kind: "snapshot",
    cursor,
    bots,
    conversations: [],
    activities: [],
    nodes: [],
    sections: [],
    settings: { ...DEFAULT_SETTINGS, sharedProjectFolders },
  })

  test("none without a LiveHub", async () => {
    const roots = await Effect.runPromise(Effect.scoped(projectFolderRoots))
    expect(roots).toBeUndefined()
  })

  test("each bot gets its own profile's shared folders ∪ its own, kept current from every roster", async () => {
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rosters = new Map<OwnerProfileId, Queue.Queue<KnownRosterStreamItem>>()
          for (const id of [MAIN_PROFILE_ID, OTHER_PROFILE, LATER_PROFILE])
            rosters.set(id, yield* Queue.unbounded<KnownRosterStreamItem>())
          const roster = (id: OwnerProfileId) => rosters.get(id)!
          const views = yield* Queue.unbounded<OwnerProfilesView>()
          const first: OwnerProfilesView = {
            profiles: [profile(MAIN_PROFILE_ID), profile(OTHER_PROFILE)],
            activeId: MAIN_PROFILE_ID,
          }
          yield* Queue.offer(views, first)
          yield* Queue.offer(roster(MAIN_PROFILE_ID), snapshot([ada, bo], ["/srv/shared"]))
          yield* Queue.offer(roster(OTHER_PROFILE), snapshot([cy], ["/srv/other-shared"]))
          const layer = Layer.mergeAll(
            Layer.mock(LiveHub, { subscribeRoster: ({ profileId }) => Stream.fromQueue(roster(profileId!)) }),
            Layer.mock(OwnerProfiles, { view: Effect.succeed(first), changes: Stream.fromQueue(views) }),
          )
          const roots = (yield* projectFolderRoots.pipe(Effect.provide(layer)))!
          const initial = { ada: roots(ada.id), bo: roots(bo.id), cy: roots(cy.id) }
          yield* Queue.offer(roster(MAIN_PROFILE_ID), {
            kind: "change",
            cursor,
            change: { type: "bot.upserted", bot: { ...bo, projectFolders: ["/srv/bo"] } },
          })
          yield* Queue.offer(roster(MAIN_PROFILE_ID), {
            kind: "change",
            cursor,
            change: { type: "bot.removed", botId: ada.id },
          })
          yield* Queue.offer(roster(MAIN_PROFILE_ID), {
            kind: "change",
            cursor,
            change: { type: "settings.updated", settings: DEFAULT_SETTINGS },
          })
          yield* Queue.offer(views, { ...first, profiles: [...first.profiles, profile(LATER_PROFILE)] })
          yield* Queue.offer(roster(LATER_PROFILE), snapshot([dee], ["/srv/later"]))
          for (let i = 0; i < 100 && (roots(bo.id).join() !== "/srv/bo" || roots(dee.id).length === 0); i++) {
            yield* Effect.yieldNow
          }
          return { initial, later: { ada: roots(ada.id), bo: roots(bo.id), cy: roots(cy.id), dee: roots(dee.id) } }
        }),
      ),
    )
    expect(out.initial).toEqual({
      ada: ["/srv/shared", "/srv/snip"],
      bo: ["/srv/shared"],
      cy: ["/srv/other-shared", "/srv/cy"],
    })
    expect(out.later).toEqual({ ada: [], bo: ["/srv/bo"], cy: ["/srv/other-shared", "/srv/cy"], dee: ["/srv/later"] })
  })
})
