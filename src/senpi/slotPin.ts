// WHERE A PIN LIVES, and why it is a file rather than a variable.
//
// A pin used to be per-process state: the host whose panel the operator pressed `p` in held it, and
// the other senpi hosts on the same machine knew nothing about it. That is not a smaller version of
// the feature, it is a different one. omo runs a TUI host, a `--mode rpc` shared host and one host
// per detached session — measured at five on one laptop — and they all lease under the SAME workerId
// and the SAME slot name. One host naming an account while the other four take the master's ranked
// pick is how a machine configured `slots: 1` comes to hold two accounts at once: the master books
// ONE holder, so the second lease displaces the first, the token the displaced host is still
// publishing is answered 401, and its recovery EXCLUDES the account it just failed on — which lands
// it on the other one. The two then trade places every few minutes while the master reports both
// healthy, because from its side nothing is wrong.
//
// The convergence that prevents all of this is leaseCache's adoption, and a pinned slot refused to
// adopt at all. So the pin has to be a property of THIS MACHINE'S SLOT, readable by every host.
//
// OUTLIVING THE PROCESS THAT SET IT IS THE POINT, not a regression. opencode's pin is persisted in
// TuiKV for the same reason, and a pin the master will not serve is still given up by the one path
// allowed to give it up (see pin.ts), so a stale instruction cannot survive a renewal that the master
// refuses.
//
// ITS OWN FILE, NOT A FIELD IN senpi-lease-cache.json. That file is whole-file rewritten on every
// lease publish; a pin sharing it would be read-modify-written from two unrelated triggers — a
// publish here, a keypress there — and one of them would lose. Nothing in this module ever touches a
// lease and nothing in leaseCache.ts ever touches a pin, so the two cannot race at all.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { log } from "../logger.ts"
import { leaseCacheDir } from "./leaseCache.ts"

const PIN_FILE = "senpi-slot-pins.json"
const PIN_VERSION = 1

export function slotPinPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(leaseCacheDir(env), PIN_FILE)
}

// SYNCHRONOUS, exactly as leaseCache's read is and for the same reason: this is consulted while a
// lease request is being built, and an async read would let the request go out before the answer
// arrived. Unreadable file, wrong version and malformed members all read as "no pin" — an unpinned
// slot is the ordinary state, never a fault.
function readPins(env: NodeJS.ProcessEnv): Record<string, string> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(slotPinPath(env), "utf-8"))
  } catch {
    return {}
  }
  if (typeof raw !== "object" || raw === null) return {}
  const { version, pins } = raw as Record<string, unknown>
  if (version !== PIN_VERSION || typeof pins !== "object" || pins === null) return {}
  const usable: Record<string, string> = {}
  for (const [slotName, prefix] of Object.entries(pins as Record<string, unknown>)) {
    if (typeof prefix === "string" && prefix.length > 0) usable[slotName] = prefix
  }
  return usable
}

export function readSlotPin(slotName: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readPins(env)[slotName]
}

// Synchronous so the intent the operator just expressed is on disk for the next reader — including
// the hosts that never saw the keypress. Best effort: an unwritable pool directory must not fail the
// switch that was asked for, and the worst case is the pin degrading to what it was before this file
// existed.
export function writeSlotPin(
  slotName: string,
  idPrefix: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const pins = readPins(env)
  if (idPrefix === undefined) delete pins[slotName]
  else pins[slotName] = idPrefix
  const path = slotPinPath(env)
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify({ version: PIN_VERSION, pins }, null, 2), { mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    log.warn("senpi:slot-pin-write-fail", { slotName, error: error instanceof Error ? error.message : String(error) })
  }
}
