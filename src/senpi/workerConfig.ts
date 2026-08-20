// The worker identity a senpi machine keeps between runs, so `omo` on its own is enough.
//
// WHY IT EXISTS. The extension can only lease if it knows the master and its own id, and reading
// those from the environment alone means every launch has to carry them — a plain `omo` returns
// early, never reads the warm lease sitting on disk, and dies with "No models available" against a
// full pool. Configure once, and every later launch is an ordinary `omo`.
//
// ENVIRONMENT STILL WINS, FIELD BY FIELD. A machine already driven by CAP_* variables must behave
// exactly as it did before this file existed, and a one-off override must not require editing the
// stored config.
//
// NOT A CREDENTIAL. Only the master's address, this worker's label and a slot count live here; the
// leases stay in senpi-lease-cache.json. Written through atomicWriteJson anyway, which forces 0600 —
// it costs nothing and this file sits next to one that really is secret.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { atomicWriteJson } from "../accounts.ts"
import { isWorkerLabel, WORKER_LABEL_PATTERN } from "../cloud/protocol.ts"
import { parseSlotCount, SENPI_MAX_ENV_SLOTS } from "./envSlot.ts"
import { leaseCacheDir } from "./leaseCache.ts"

export type WorkerConfig = { masterUrl: string; workerId: string; slots?: number }

const CONFIG_FILE = "senpi-worker.json"
const CONFIG_VERSION = 1

export function workerConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(leaseCacheDir(env), CONFIG_FILE)
}

function isMasterUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false
  try {
    // Parsed rather than pattern-matched, and the protocol checked explicitly: a bare `host:port`
    // parses as a URL whose protocol is `host:`, which would otherwise sail through here and fail
    // much later as an unreachable master.
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * The stored config, or undefined for anything this worker cannot act on. A missing file is the
 * normal state of a machine that is not a pool worker, so it is not reported as a fault.
 */
export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(workerConfigPath(env), "utf-8"))
  } catch {
    return undefined
  }
  if (typeof raw !== "object" || raw === null) return undefined
  const { version, masterUrl, workerId, slots } = raw as Record<string, unknown>
  if (version !== CONFIG_VERSION) return undefined
  // BOTH or nothing: leasing needs an address and an identity, and half a config is not half a
  // worker — it is a worker that would 400 on every request.
  if (!isMasterUrl(masterUrl) || !isWorkerLabel(workerId)) return undefined
  const usable =
    typeof slots === "number" && Number.isInteger(slots) && slots >= 1 ? Math.min(slots, SENPI_MAX_ENV_SLOTS) : undefined
  return { masterUrl, workerId, ...(usable === undefined ? {} : { slots: usable }) }
}

export async function writeWorkerConfig(config: WorkerConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await atomicWriteJson(workerConfigPath(env), { version: CONFIG_VERSION, ...config })
}

/**
 * What the extension acts on: the stored config with any CAP_* variable taking precedence. Undefined
 * unless both an address and an identity resolve from somewhere.
 */
export function resolveWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig | undefined {
  const stored = readWorkerConfig(env)
  const masterUrl = env.CAP_MASTER_URL ?? stored?.masterUrl
  const workerId = env.CAP_WORKER_ID ?? stored?.workerId
  if (!isMasterUrl(masterUrl) || !isWorkerLabel(workerId)) return undefined
  const slots = env.CAP_SENPI_SLOTS !== undefined ? parseSlotCount(env.CAP_SENPI_SLOTS) : stored?.slots
  return { masterUrl, workerId, ...(slots === undefined ? {} : { slots }) }
}

/**
 * Checks raw CLI strings before anything is written. Refusing here is the whole point: the master
 * answers a bad workerId with a 400 the operator only meets much later, at lease time.
 */
export function validateWorkerConfig(input: {
  masterUrl?: string
  workerId?: string
  slots?: string
}): { ok: true; config: WorkerConfig } | { ok: false; error: string } {
  if (!isMasterUrl(input.masterUrl)) {
    return { ok: false, error: `masterUrl must be an http(s) URL, got ${JSON.stringify(input.masterUrl ?? null)}` }
  }
  if (!isWorkerLabel(input.workerId)) {
    return {
      ok: false,
      error: `workerId must match ${WORKER_LABEL_PATTERN.source} (a colon is not allowed), got ${JSON.stringify(input.workerId ?? null)}`,
    }
  }
  // Junk is REFUSED here while parseSlotCount silently defaults it: a typed `--slots abc` is a
  // person's mistake to correct now, not a worker that quietly runs on one slot forever.
  if (input.slots !== undefined && !/^\d+$/.test(input.slots)) {
    return { ok: false, error: `slots must be a positive integer, got ${JSON.stringify(input.slots)}` }
  }
  return { ok: true, config: { masterUrl: input.masterUrl, workerId: input.workerId, slots: parseSlotCount(input.slots) } }
}
