// "Full desktop needs Xvfb, x11vnc… on ‹node›" with copyable install commands (Details › Computer,
// Settings › Computers). Desktops are X11, so the commands are Linux only.
import { cn } from "@openbot/ui"
import type { ReactNode } from "react"
import { CommandBlock } from "../details/kit.tsx"
import { describeMissing, desktopInstallHints } from "./desktop.ts"

export function DesktopSetupNote({
  missing,
  nodeName,
  platform,
  local = false,
  className,
}: {
  /** What the node lacks (`computer.status.missing`); empty = not known, list the usual set. */
  readonly missing: ReadonlyArray<string>
  readonly nodeName: string
  readonly platform?: string | undefined
  /** The brain's own computer (restart OpenBot) rather than a paired node (restart its node). */
  readonly local?: boolean
  readonly className?: string
}): ReactNode {
  const hints = desktopInstallHints(platform, missing)
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)} data-testid="desktop-setup">
      <p className="text-sm text-fg-secondary">
        {missing.length > 0 ? `Full desktop needs ${describeMissing(missing)} on ` : "Full desktop isn't set up on "}
        <span className="whitespace-nowrap">{nodeName}</span>.{" "}
        {hints.length === 0
          ? "Full desktops need Linux (Xvfb, x11vnc)."
          : local
            ? "Run bun run setup-desktop where OpenBot runs, or install these, then restart OpenBot."
            : "Run its installer again, or install these there, then restart its OpenBot node."}
      </p>
      {hints.map((h) => (
        <div key={h.label} className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-fg-tertiary">{h.label}</span>
          <CommandBlock command={h.command} />
        </div>
      ))}
    </div>
  )
}
