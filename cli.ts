// `claude-accounts-pool` — configures this machine as a senpi pool worker, once.
//
// The goal of `configure` is that you never need this CLI again: it writes the worker identity next
// to the lease cache, and from then on a plain `omo` leases from the pool by itself. `start` stays
// for the cases config cannot cover — a one-off master, or the senpi-side guards that are not pool
// configuration and so do not belong in the config file.
import { spawn } from "node:child_process"
import { readLeaseCache, leaseCachePath } from "./src/senpi/leaseCache.ts"
import { readWorkerConfig, resolveWorkerConfig, validateWorkerConfig, workerConfigPath, writeWorkerConfig } from "./src/senpi/workerConfig.ts"

const USAGE = `claude-accounts-pool — senpi pool worker setup

  configure --master <url> --worker <id> [--slots <n>]
      Store this machine's worker identity. Afterwards a plain \`omo\` leases from the pool.

  start [omo args...]
      Launch omo with the stored config plus the senpi-side guards, passing arguments through.

  status
      Show the resolved config, where it came from, and what each token slot currently holds.

Environment overrides (win over the stored config, for a single run):
  CAP_MASTER_URL   CAP_WORKER_ID   CAP_SENPI_SLOTS   CAP_LEASE_CACHE_DIR
`

// Set by `start` and deliberately NOT stored in the config file: they configure senpi, not the pool.
// oauth-slots pins the lane rather than letting it be inferred, and NO_FALLBACK keeps a failed lease
// from being answered by some other provider.
const SENPI_GUARDS = { SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION: "oauth-slots", SENPI_NO_FALLBACK: "1" }

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = args[index + 1]
  return value === undefined || value.startsWith("--") ? undefined : value
}

async function configure(args: readonly string[]): Promise<number> {
  const outcome = validateWorkerConfig({
    masterUrl: flag(args, "master"),
    workerId: flag(args, "worker"),
    slots: flag(args, "slots"),
  })
  if (!outcome.ok) {
    console.error(`claude-accounts-pool: ${outcome.error}`)
    return 2
  }
  await writeWorkerConfig(outcome.config)
  console.log(`wrote ${workerConfigPath()}`)
  console.log(`  master ${outcome.config.masterUrl}`)
  console.log(`  worker ${outcome.config.workerId}`)
  console.log(`  slots  ${outcome.config.slots ?? 1}`)
  console.log(`\nA plain \`omo\` now leases from the pool. First launch must be interactive so the`)
  console.log(`startup lease can land and warm the cache; \`-p\` runs work from then on.`)
  return 0
}

function status(): number {
  const stored = readWorkerConfig()
  const resolved = resolveWorkerConfig()
  console.log(`config  ${workerConfigPath()}${stored ? "" : "  (absent or unusable)"}`)
  console.log(`cache   ${leaseCachePath()}`)
  if (!resolved) {
    console.log(`\nNot configured as a pool worker. Run \`claude-accounts-pool configure --master <url> --worker <id>\`.`)
    return 1
  }
  // Named per field so an unexpected value is traceable to the environment or the file without
  // having to read both by hand.
  const source = (field: "CAP_MASTER_URL" | "CAP_WORKER_ID" | "CAP_SENPI_SLOTS") =>
    process.env[field] === undefined ? "file" : "env"
  console.log(`\nmaster  ${resolved.masterUrl}  (${source("CAP_MASTER_URL")})`)
  console.log(`worker  ${resolved.workerId}  (${source("CAP_WORKER_ID")})`)
  console.log(`slots   ${resolved.slots ?? 1}  (${source("CAP_SENPI_SLOTS")})`)

  const cached = readLeaseCache()
  console.log(`\nslots holding a usable lease: ${cached.size}`)
  for (const [slotName, lease] of cached) {
    // The account and the horizon only — the access token is a live credential and is never printed.
    console.log(`  ${slotName}  account ${lease.accountId}  expires ${new Date(lease.expires).toISOString()}`)
  }
  if (cached.size === 0) console.log(`  (cold — run an interactive \`omo\` once to warm it)`)
  return 0
}

function start(args: readonly string[]): number {
  const resolved = resolveWorkerConfig()
  if (!resolved) {
    console.error(`claude-accounts-pool: not configured; run \`claude-accounts-pool configure --master <url> --worker <id>\``)
    return 2
  }
  const child = spawn("omo", args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...SENPI_GUARDS,
      CAP_MASTER_URL: resolved.masterUrl,
      CAP_WORKER_ID: resolved.workerId,
      ...(resolved.slots === undefined ? {} : { CAP_SENPI_SLOTS: String(resolved.slots) }),
    },
  })
  // The launcher's exit code is the user's exit code, and a signal death is reported as one rather
  // than as a silent success.
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 0)
  })
  child.on("error", (error) => {
    console.error(`claude-accounts-pool: could not launch omo: ${error.message}`)
    process.exitCode = 127
  })
  return 0
}

const argv = process.argv.slice(2)
const command = argv[0]
if (command === "configure") process.exitCode = await configure(argv.slice(1))
else if (command === "status") process.exitCode = status()
else if (command === "start") process.exitCode = start(argv.slice(1))
else {
  console.log(USAGE)
  process.exitCode = command === undefined || command === "--help" || command === "-h" ? 0 : 2
}
