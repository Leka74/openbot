/**
 * Owner profiles. Each profile has its own Bots (and through them their chats, memory, routines and
 * tasks), sections, rules, attachments, settings, skills library and connections. Computers and
 * harness logins are shared. One profile is active: the apps show it. The others keep running.
 *
 * `CurrentProfile` is the profile a piece of work belongs to. It is set where work enters the brain:
 * the RPC edge (the active profile), the MCP gateway (the calling Bot's profile) and background work
 * (the profile of the Bot it runs for). Owner-facing lists and lookups read it.
 */
import type {
  AwaySummary,
  Forbidden,
  HeldNotification,
  InvalidInput,
  Millis,
  NotFound,
  NotificationId,
  OwnerProfile,
  OwnerProfileId,
  OwnerProfilesView,
} from "@openbot/contracts"
import { Context, Effect, Option, Stream } from "effect"
import type { RepoError } from "./errors.ts"

export class CurrentProfile extends Context.Service<CurrentProfile, { readonly id: OwnerProfileId }>()(
  "openbot/core/CurrentProfile",
) {}

export const currentProfileId: Effect.Effect<OwnerProfileId, never, CurrentProfile> = Effect.map(
  CurrentProfile,
  (profile) => profile.id,
)

/** Runs `effect` as work of `profileId`. */
export const inProfile =
  (profileId: OwnerProfileId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, CurrentProfile>> =>
    Effect.provideService(effect, CurrentProfile, { id: profileId })

export class OwnerProfileRepo extends Context.Service<
  OwnerProfileRepo,
  {
    /** Ordered by `createdAt` ascending (the main profile first). */
    readonly list: Effect.Effect<ReadonlyArray<OwnerProfile>, RepoError>
    readonly get: (id: OwnerProfileId) => Effect.Effect<Option.Option<OwnerProfile>, RepoError>
    readonly upsert: (profile: OwnerProfile) => Effect.Effect<void, RepoError>
    readonly delete: (id: OwnerProfileId) => Effect.Effect<void, RepoError>
  }
>()("openbot/core/OwnerProfileRepo") {}

export class OwnerProfiles extends Context.Service<
  OwnerProfiles,
  {
    readonly view: Effect.Effect<OwnerProfilesView>
    readonly active: Effect.Effect<OwnerProfileId>
    /**
     * Runs `f` with the active profile, which can't change until `f` ends (a switch waits). `f` must not
     * create, rename, switch or delete profiles.
     */
    readonly withActive: <A, E, R>(f: (activeId: OwnerProfileId) => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
    /** The view now, then after every change (a switch, a new or renamed profile). */
    readonly changes: Stream.Stream<OwnerProfilesView>
    /** Fails with `NotFound` for an unknown profile. */
    readonly require: (id: OwnerProfileId) => Effect.Effect<OwnerProfile, NotFound>
    readonly create: (name: string) => Effect.Effect<OwnerProfile, InvalidInput>
    readonly rename: (id: OwnerProfileId, name: string) => Effect.Effect<OwnerProfile, NotFound | InvalidInput>
    /** Fails with `NotFound` for an unknown profile or one being deleted. */
    readonly switchTo: (id: OwnerProfileId) => Effect.Effect<void, NotFound>
    /** Fails with `NotFound` unless the profile exists and is not being deleted (nothing new starts in it). */
    readonly usable: (id: OwnerProfileId) => Effect.Effect<void, NotFound>
    /**
     * Runs `f`, which adds something to the profile, only if it is `usable`; a delete waits for `f` to end,
     * so it removes what `f` added. `f` must not create, rename, switch or delete profiles.
     */
    readonly adding: <A, E, R>(id: OwnerProfileId, f: Effect.Effect<A, E, R>) => Effect.Effect<A, E | NotFound, R>
    /**
     * Deletes a profile: never the main or the active one, nor one already being deleted. The profile is
     * marked deleting first (no switch to it, nothing new in it), `purge` removes what it has, then the
     * profile is forgotten. When `purge` fails the mark goes, so deleting again picks up where it stopped.
     */
    readonly remove: <E>(
      id: OwnerProfileId,
      purge: Effect.Effect<void, E>,
    ) => Effect.Effect<void, NotFound | Forbidden | E>
  }
>()("openbot/core/OwnerProfiles") {}

/** What stays of a deleted profile in storage after its Bots are gone: its rows, in one go. */
export class ProfileStorage extends Context.Service<
  ProfileStorage,
  {
    /**
     * Deletes the profile's sections, rules, settings, attachment records, held notifications and away
     * state, and the brain's create-once keys that name its Bots and groups.
     */
    readonly purge: (
      profileId: OwnerProfileId,
      gone: { readonly botIds: ReadonlyArray<string>; readonly conversationIds: ReadonlyArray<string> },
    ) => Effect.Effect<void, RepoError>
  }
>()("openbot/core/ProfileStorage") {}

export class ProfileRemoval extends Context.Service<
  ProfileRemoval,
  {
    /**
     * `profiles.delete`: removes a profile with everything of it (its groups, its Bots with their chats,
     * memory, routines and tasks, its sections, rules and settings). Never the main or the active one.
     */
    readonly remove: (id: OwnerProfileId) => Effect.Effect<void, NotFound | Forbidden>
  }
>()("openbot/core/ProfileRemoval") {}

/**
 * Notifications held for profiles that weren't active, for their "While you were away" view. Items
 * keep the order they were held in.
 */
export class HeldNotificationRepo extends Context.Service<
  HeldNotificationRepo,
  {
    /** Keeps `held` for `profileId`; past `cap` items the oldest go and are counted as dropped. */
    readonly hold: (profileId: OwnerProfileId, held: HeldNotification, cap: number) => Effect.Effect<void, RepoError>
    readonly summary: (profileId: OwnerProfileId) => Effect.Effect<AwaySummary, RepoError>
    /** Clears the items up to and including `through` and the dropped count; an unknown id clears nothing. */
    readonly dismiss: (profileId: OwnerProfileId, through: NotificationId) => Effect.Effect<void, RepoError>
    /** The owner left `profileId` at `at` (the summary's `since`). */
    readonly markLeft: (profileId: OwnerProfileId, at: Millis) => Effect.Effect<void, RepoError>
  }
>()("openbot/core/HeldNotificationRepo") {}

/** The active profile's "While you were away" list. */
export class Away extends Context.Service<
  Away,
  {
    readonly summary: Effect.Effect<AwaySummary, never, CurrentProfile>
    /** Clears up to and including `through`, so an item held while the view was open stays. */
    readonly dismiss: (through: NotificationId) => Effect.Effect<AwaySummary, never, CurrentProfile>
  }
>()("openbot/core/Away") {}
