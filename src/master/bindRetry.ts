import { MASTER_BIND_RETRY_BASE_MS, MASTER_BIND_RETRY_CAP_MS } from "../constants.ts"
import { log } from "../logger.ts"

// Keeps trying to open the master's port until the interface it names exists.
//
// WHY THIS EXISTS. `Bun.serve` throws synchronously when `hostname` is not an address on this box,
// and the one address this deployment binds is a Tailscale one — absent until tailscaled has come
// up, which on a box that booted without network is minutes after opencode loaded the plugin. The
// throw used to escape installCloudMaster AFTER the keeper and usage poller were already running,
// and the plugin loader swallowed it without a log line. The result was the worst half-state: a
// master still refreshing every chain (so no second refresher could ever safely step in) that
// nobody could lease from, in a process that never exited and so was never restarted by launchd.
//
// Retrying rather than exiting: this code runs inside opencode, and a plugin that killed its host
// on a network hiccup would take down whatever else that host was doing — outside launchd there is
// nothing to bring it back.

export type BindRetryDeps<S extends { stop: () => void }> = {
  // ONE bind attempt; throws when the address is not there. Injected so a test can fail it on
  // demand — there is no portable way to make a real interface appear mid-test.
  start: () => S
  // Only for the log line: the attempt itself is entirely inside `start`.
  hostname: string
  port: number
  // The plugin lifecycle signal. Aborting it ends the retry loop and closes a server it had opened.
  signal: AbortSignal
  // NO DEFAULT, as in keeper.ts: a test that forgot it would wait out the real backoff.
  sleep: (ms: number) => Promise<void>
}

export type BindRetryHandle<S> = {
  // Resolves with the server once bound, or `undefined` if stopped first. Never rejects.
  bound: Promise<S | undefined>
  stop: () => void
}

export function startWithBindRetry<S extends { stop: () => void }>(deps: BindRetryDeps<S>): BindRetryHandle<S> {
  let stopped = false
  let server: S | undefined

  const stop = (): void => {
    stopped = true
    server?.stop()
  }
  deps.signal.addEventListener("abort", stop, { once: true })
  if (deps.signal.aborted) stopped = true

  // The FIRST attempt runs synchronously inside this call (an async function runs up to its first
  // await), so on a healthy boot the port is open by the time installCloudMaster returns — the
  // same ordering as before this module existed.
  const bound = (async (): Promise<S | undefined> => {
    for (let attempt = 1; !stopped; attempt++) {
      try {
        server = deps.start()
        return server
      } catch (error) {
        const retryInMs = Math.min(MASTER_BIND_RETRY_BASE_MS * 2 ** (attempt - 1), MASTER_BIND_RETRY_CAP_MS)
        const { code } = (error ?? {}) as { code?: unknown }
        // Bun reports a missing interface as EADDRINUSE ("Is port N in use?"), so the code alone
        // points at the wrong culprit. The hostname is logged beside it for that reason.
        log.warn("master:lease-server-bind-fail", {
          hostname: deps.hostname,
          port: deps.port,
          attempt,
          retryInMs,
          errCode: code,
          error: error instanceof Error ? error.message : String(error),
        })
        await deps.sleep(retryInMs)
      }
    }
    return undefined
  })()

  return { bound, stop }
}
