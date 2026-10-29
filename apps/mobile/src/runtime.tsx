// The app's session and its OpenBot client: the shared @openbot/client runtime (one `/rpc` socket,
// live roster and conversation replicas) pointed at the owner's OpenBot, the session sent as the
// bearer token (React Native sockets take headers; the web build rides on the browser's cookie).
import { RegistryProvider, useAtomValue } from "@effect/atom-react"
import { activeProfileIdAtom, clientConfigAtom, defaultClientConfig } from "@openbot/client"
import type { OwnerProfileId } from "@openbot/contracts"
import { router } from "expo-router"
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { Platform } from "react-native"
import { clearConnection, type Connection, loadConnection, saveConnection, sessionHeaders } from "./session.ts"

interface SessionValue {
  /** undefined while loading from the keychain; null when not connected */
  readonly connection: Connection | null | undefined
  readonly connected: (c: Connection) => Promise<void>
  readonly disconnect: () => Promise<void>
}

const SessionContext = createContext<SessionValue | undefined>(undefined)

export const useSession = (): SessionValue => {
  const value = useContext(SessionContext)
  if (!value) throw new Error("useSession outside SessionProvider")
  return value
}

/** The current connection (screens behind the connect screen only). */
export const useConnection = (): Connection => {
  const { connection } = useSession()
  if (!connection) throw new Error("not connected")
  return connection
}

export function SessionProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [connection, setConnection] = useState<Connection | null | undefined>(undefined)
  useEffect(() => {
    void loadConnection().then((c) => setConnection(c ?? null))
  }, [])
  const connected = useCallback(async (c: Connection) => {
    await saveConnection(c)
    setConnection(c)
  }, [])
  const disconnect = useCallback(async () => {
    await clearConnection()
    setConnection(null)
  }, [])
  const value = useMemo(() => ({ connection, connected, disconnect }), [connection, connected, disconnect])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

/** Switching profiles (on any device) switches this app too: back to Home, with nothing of the old one. */
function FollowActiveProfile({ onSwitch }: { readonly onSwitch: () => void }): ReactNode {
  const activeId = useAtomValue(activeProfileIdAtom)
  const loadedWith = useRef<OwnerProfileId | undefined>(undefined)
  useEffect(() => {
    if (activeId === undefined) return
    loadedWith.current ??= activeId
    if (activeId === loadedWith.current) return
    if (router.canDismiss()) router.dismissAll()
    onSwitch()
  }, [activeId, onSwitch])
  return null
}

/** A fresh client runtime per connection and per profile switch (a new OpenBot or session rebuilds everything). */
export function ClientProvider({
  connection,
  children,
}: {
  readonly connection: Connection
  readonly children: ReactNode
}): ReactNode {
  const [switches, setSwitches] = useState(0)
  const switched = useCallback(() => setSwitches((n) => n + 1), [])
  const config = defaultClientConfig({
    url: `${connection.origin.replace(/^http/, "ws")}/rpc`,
    ...(Platform.OS === "web" ? {} : { headers: sessionHeaders(connection) }),
  })
  return (
    <RegistryProvider
      key={`${connection.origin} ${connection.sessionToken} ${switches}`}
      initialValues={[[clientConfigAtom, config]]}
    >
      <FollowActiveProfile onSwitch={switched} />
      {children}
    </RegistryProvider>
  )
}
