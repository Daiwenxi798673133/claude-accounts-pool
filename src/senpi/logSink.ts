// The senpi entry's log sink, and the reason it has to exist at all.
//
// senpi's ExtensionApi carries NO logging surface — checked against 2026.8.28's types.d.ts, whose
// interface has no log member of any shape. opencode hands tui.tsx an `api.client` that already
// speaks app.log, so THAT entry has had a sink since day one and this one never did: initLogger was
// never called here, so every guard() in senpi-extension.ts swallowed its error into a logger with
// no client. A fault on this lane left no trace anywhere on the machine, which is what turned one
// broken `/usage` into an afternoon of process archaeology.
//
// A FILE, because the only other thing an extension can write to on this surface is stdout, and
// stdout belongs to the TUI's renderer.
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { leaseCacheDir } from "./leaseCache.ts"

const LOG_FILE = "senpi-extension.log"

export function senpiLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(leaseCacheDir(env), LOG_FILE)
}

type LogPayload = {
  service?: string
  level?: string
  message?: string
  extra?: Record<string, unknown>
}

/**
 * A LogClient for initLogger that appends one JSON object per line.
 *
 * Never guarded here: initLogger's forward() already wraps every call in try/catch, so a write that
 * throws (directory gone, disk full) costs a record rather than a turn. Duplicating that guard would
 * only hide which of the two swallowed it.
 */
export function createFileLogClient(env: NodeJS.ProcessEnv = process.env): {
  app: { log: (payload: LogPayload) => void }
} {
  const path = senpiLogPath(env)
  return {
    app: {
      // 0600 applies on creation only, and matters because this file lands beside senpi-lease-cache.json.
      // The records themselves carry no credential — callers pass tags and error strings.
      log: (payload) => appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`, { mode: 0o600 }),
    },
  }
}
