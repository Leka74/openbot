import { getRandomValues, randomUUID } from "expo-crypto"

interface CryptoGlobal {
  getRandomValues?: typeof getRandomValues
  randomUUID?: typeof randomUUID
}

const scope = globalThis as { crypto?: CryptoGlobal }
const crypto: CryptoGlobal = scope.crypto ?? {}
crypto.getRandomValues ??= getRandomValues
crypto.randomUUID ??= randomUUID
scope.crypto = crypto
