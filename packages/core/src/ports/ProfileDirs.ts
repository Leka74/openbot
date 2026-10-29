/**
 * `ProfileDirs` port: the folders of an owner profile on disk (`DataDir.profile(id)`). The main
 * profile's are the data root's own and are never moved.
 */
import type { InvalidInput, OwnerProfileId } from "@openbot/contracts"
import { Context, type Effect } from "effect"
import type { RepoError } from "./errors.ts"

export class ProfileDirs extends Context.Service<
  ProfileDirs,
  {
    /** Creates the profile's skills library (with its plugin manifest) and attachments folder; idempotent. */
    readonly ensure: (id: OwnerProfileId) => Effect.Effect<void, RepoError>
    /**
     * Moves `profiles/<id>` aside to `profiles/.deleted-<id>-<ms>` (nothing is removed); nothing to do
     * when it does not exist. Fails with `InvalidInput` for the main profile.
     */
    readonly retire: (id: OwnerProfileId) => Effect.Effect<void, RepoError | InvalidInput>
  }
>()("openbot/core/ProfileDirs") {}
