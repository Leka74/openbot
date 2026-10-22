import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Option } from "effect"
import { EntryRepo } from "../../src/ports/index.ts"
import { makeMemoryEntryRepo, MemoryPersistence, repoContractCases, searchContractCases, SequentialIdGen } from "../../src/testing/index.ts"

const layer = MemoryPersistence.pipe(Layer.provide(SequentialIdGen()))

describe("in-memory repositories satisfy the repository contract", () => {
  for (const c of repoContractCases) {
    // A fresh layer per case: cases expect empty repositories.
    test(c.name, async () => {
      await Effect.runPromise(Effect.provide(c.run, layer))
    })
  }

  for (const c of searchContractCases) {
    test(c.name, async () => {
      await Effect.runPromise(Effect.provide(c.run, layer))
    })
  }

  test("the contract suite covers every repository and store port", () => {
    const covered = new Set([...repoContractCases, ...searchContractCases].map((c) => c.name.split(":")[0]))
    for (
      const port of [
        "BotRepo",
        "SectionRepo",
        "ConversationRepo",
        "EntryRepo",
        "SearchRepo",
        "RequestRepo",
        "TurnRepo",
        "RoutineRepo",
        "NodeRepo",
        "ApprovalRuleRepo",
        "SettingsRepo",
        "UsageRepo",
        "ReplicaLog",
        "McpTokenRepo",
        "ProcessLedger",
        "MemoryStore",
        "SkillStore",
        "AttachmentStore",
      ]
    ) expect(covered.has(port)).toBe(true)
  })
})

describe("the contract suite is not vacuous", () => {
  test("an EntryRepo without the revision guard fails the revision case", async () => {
    const broken = Layer.effect(
      EntryRepo,
      Effect.map(makeMemoryEntryRepo(), (repo) =>
        EntryRepo.of({
          ...repo,
          // Always overwrite: bump the revision so the real guard accepts it.
          upsert: (entry) =>
            Effect.flatMap(repo.get(entry.id), (current) =>
              repo.upsert({ ...entry, revision: Option.isSome(current) ? current.value.revision + 1 : entry.revision })),
        })),
    )
    const revisionCase = repoContractCases.find((c) => c.name.startsWith("EntryRepo: revision guard"))!
    const exit = await Effect.runPromiseExit(Effect.provide(revisionCase.run, Layer.merge(layer, broken)))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
