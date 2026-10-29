/** `ProfileDirs` on disk. */
import { InvalidInput, MAIN_PROFILE_ID } from "@openbot/contracts"
import { type DataDirShape, joinPath, ProfileDirs } from "@openbot/core"
import { Clock, Effect } from "effect"
import { ensureDirectory, movePath, readTextFile, writeFileAtomic } from "./files.ts"
import { PLUGIN_MANIFEST, pluginManifest } from "./skillStore.ts"

export const makeProfileDirs = (dataDir: DataDirShape) =>
  ProfileDirs.of({
    ensure: (id) =>
      Effect.gen(function* () {
        const paths = dataDir.profile(id)
        yield* ensureDirectory("ProfileDirs.ensure", paths.attachments)
        yield* ensureDirectory("ProfileDirs.ensure", joinPath(paths.skillsLib, "skills"))
        const manifest = joinPath(paths.skillsLib, PLUGIN_MANIFEST)
        if ((yield* readTextFile("ProfileDirs.ensure", manifest)) === undefined) {
          yield* writeFileAtomic("ProfileDirs.ensure", manifest, `${JSON.stringify(pluginManifest, null, 2)}\n`)
        }
      }),
    retire: (id) =>
      Effect.gen(function* () {
        if (id === MAIN_PROFILE_ID) {
          return yield* new InvalidInput({ message: "The main profile's files stay where they are." })
        }
        const from = dataDir.profile(id).root
        const name = from.slice(from.lastIndexOf("/") + 1)
        const to = joinPath(dataDir.profiles, `.deleted-${name}-${yield* Clock.currentTimeMillis}`)
        yield* movePath("ProfileDirs.retire", from, to)
      }),
  })
