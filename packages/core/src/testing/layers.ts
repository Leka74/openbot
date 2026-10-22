/**
 * Composite test layers and `TestClock` helpers.
 *
 * - `MemoryPersistence`: every repository + store port in memory (the in-memory mirror of
 *   `PersistenceLive(dataDir)` from `@openbot/persistence`).
 * - `TestPorts`: `MemoryPersistence` + `MemoryBootRecovery` + sequential `IdGen` + `DataDir` +
 *   `HarnessRegistry` + `InternalAddress` + all port fakes (NodeDirectory with the local node,
 *   NodeFiles, PlacementService, McpBindingIssuer, ComputerPort, Notifier).
 */
import type { NodeSummary } from "@openbot/contracts"
import { Effect, Layer } from "effect"
import type { Duration, Scope } from "effect"
import { TestClock } from "effect/testing"
import type { ComputerPort } from "../ports/Computer.ts"
import { DataDir } from "../ports/DataDir.ts"
import { HarnessRegistry } from "../ports/Harness.ts"
import { InternalAddress } from "../ports/InternalAddress.ts"
import type { IdGen } from "../ports/IdGen.ts"
import type { McpBindingIssuer } from "../ports/Mcp.ts"
import type { NodeDirectory } from "../ports/NodeDirectory.ts"
import type { NodeFiles } from "../ports/NodeFiles.ts"
import type { Notifier } from "../ports/Notifier.ts"
import { BootRecovery, type RepositoryPorts, runBootRecovery } from "../ports/Persistence.ts"
import type { PlacementService } from "../ports/Placement.ts"
import type { ProcessRecord } from "../ports/ProcessLedger.ts"
import {
  ComputerPortFake,
  McpBindingIssuerFake,
  NodeDirectoryFake,
  NodeFilesFake,
  NotifierFake,
  PlacementServiceFake,
} from "./fakes.ts"
import { SequentialIdGen } from "./idgen.ts"
import {
  MemoryApprovalRuleRepo,
  MemoryBotRepo,
  MemoryConversationRepo,
  MemoryMcpTokenRepo,
  MemoryNodeRepo,
  MemoryProcessLedger,
  MemoryReplicaLog,
  MemoryRequestRepo,
  MemoryRoutineRepo,
  MemorySearchableTranscript,
  MemorySectionRepo,
  MemorySettingsRepo,
  MemoryTurnRepo,
  MemoryUsageRepo,
} from "./memoryRepos.ts"
import { MemoryAttachmentStore, MemoryCarryoverStore, MemoryMemoryStore, MemorySkillStore } from "./memoryStores.ts"

/** Every repository and store port (what `PersistenceLive` provides). Defined in ports. */
export type { RepositoryPorts }

export const TEST_DATA_ROOT = "/openbot-test"
/** `InternalAddress` in `TestPorts` (and the fake MCP binding base URL). */
export const TEST_INTERNAL_URL = "http://127.0.0.1:0"

/** All repositories and stores in memory. Needs `IdGen` (attachment ids). */
export const MemoryPersistence: Layer.Layer<RepositoryPorts, never, IdGen> = Layer.mergeAll(
  MemoryBotRepo,
  MemorySectionRepo,
  // entries, tasks and search share one index; it reads membership and voice turns at query time
  MemorySearchableTranscript.pipe(Layer.provideMerge(Layer.merge(MemoryConversationRepo, MemoryTurnRepo))),
  MemoryRequestRepo,
  MemoryRoutineRepo,
  MemoryNodeRepo,
  MemoryApprovalRuleRepo,
  MemorySettingsRepo(),
  MemoryUsageRepo,
  MemoryReplicaLog,
  MemoryMcpTokenRepo,
  MemoryProcessLedger,
  MemoryMemoryStore,
  MemorySkillStore(`${TEST_DATA_ROOT}/skills-lib`),
  MemoryAttachmentStore(`${TEST_DATA_ROOT}/attachments`),
  MemoryCarryoverStore,
)

/**
 * `BootRecovery` over the (in-memory) repositories using the shared rules (`runBootRecovery`).
 * No process is signalled: `killProcessGroup` defaults to "not delivered".
 */
export const MemoryBootRecovery = (options?: {
  readonly killProcessGroup?: (record: ProcessRecord) => Effect.Effect<boolean>
}): Layer.Layer<BootRecovery, never, RepositoryPorts> =>
  Layer.effect(
    BootRecovery,
    Effect.map(Effect.context<RepositoryPorts>(), (context) =>
      BootRecovery.of({
        run: Effect.provide(
          runBootRecovery({ killProcessGroup: options?.killProcessGroup ?? (() => Effect.succeed(false)) }),
          context,
        ),
      })),
  )

export type TestPortServices =
  | RepositoryPorts
  | BootRecovery
  | InternalAddress
  | IdGen
  | DataDir
  | HarnessRegistry
  | NodeDirectory
  | NodeDirectoryFake
  | NodeFiles
  | NodeFilesFake
  | PlacementService
  | PlacementServiceFake
  | McpBindingIssuer
  | McpBindingIssuerFake
  | ComputerPort
  | ComputerPortFake
  | Notifier
  | NotifierFake

/**
 * Everything a core service test needs below the service layer. Drivers register into the provided
 * (empty) `HarnessRegistry` with `HarnessRegistry.registerLayer`.
 */
export const TestPorts = (options?: {
  readonly nodes?: ReadonlyArray<NodeSummary>
  readonly dataRoot?: string
}): Layer.Layer<TestPortServices> => {
  const base = Layer.mergeAll(
    SequentialIdGen(),
    DataDir.layer(options?.dataRoot ?? TEST_DATA_ROOT),
    HarnessRegistry.layer,
    NodeDirectoryFake.layer(options?.nodes === undefined ? undefined : { nodes: options.nodes }),
    NodeFilesFake.layer,
    McpBindingIssuerFake.layer(),
    ComputerPortFake.layer,
    InternalAddress.layer(TEST_INTERNAL_URL),
  )
  const persistence = Layer.provideMerge(MemoryBootRecovery(), MemoryPersistence)
  const dependent = Layer.mergeAll(persistence, PlacementServiceFake.layer, NotifierFake.layer)
  return dependent.pipe(Layer.provideMerge(base))
}

// ============================================================================ TestClock helpers

/** A `TestClock` layer (time starts at 0 and only moves with `advance`/`setTime`). */
export const testClock = (): Layer.Layer<TestClock.TestClock> => TestClock.layer()

/** Moves the test clock forward, running every sleeper that becomes due. */
export const advance = (duration: Duration.Input): Effect.Effect<void> => TestClock.adjust(duration)

/** Sets the test clock to an absolute epoch-millis timestamp. */
export const setTime = (timestamp: number): Effect.Effect<void> => TestClock.setTime(timestamp)

/**
 * Runs a scoped effect with a fresh `TestClock` (and the given layer) and returns a Promise —
 * the usual shape of a `bun:test` body: `test("x", () => runTest(effect, TestPorts()))`.
 */
export const runTest = <A, E, ROut>(
  effect: Effect.Effect<A, E, ROut | TestClock.TestClock | Scope.Scope>,
  layer?: Layer.Layer<ROut, E>,
): Promise<A> => {
  const withLayer = layer === undefined
    ? (effect as Effect.Effect<A, E, TestClock.TestClock | Scope.Scope>)
    : Effect.provide(effect, layer)
  return Effect.runPromise(Effect.scoped(Effect.provide(withLayer, testClock())))
}
