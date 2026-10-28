/**
 * `bun run setup-desktop`: installs the programs bot desktops use on this Linux machine (the one that
 * runs OpenBot; paired computers get them from their installer, /node/install.sh). Same steps as the
 * installer's (`desktopSetupSh`): apt-get or pacman, through sudo when not root. Then restart OpenBot,
 * or open a bot's screen again: a new screen uses what is installed.
 */
import { desktopSetupSh } from "../packages/brain-nodes/src/NodeInstall.ts"

const proc = Bun.spawnSync(["sh", "-c", `${desktopSetupSh}\nsetup_desktop`], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(proc.exitCode ?? 1)
