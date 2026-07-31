import { expect, test, mock } from "bun:test"
import type { TuiDispose, TuiPluginApi, TuiToast } from "@opencode-ai/plugin/tui"
import type { ModeConfig } from "../mode.ts"

// WHY THIS TESTS dispatchMode AND NOT tui.tsx. tui.tsx is a Solid component module whose import
// graph boots the whole TUI; the decision it makes on load — which of three worlds this process
// becomes — is extracted here so it can be driven as a value. What is under test is therefore the
// SELECTION ONLY: which module gets reached for, what gets registered for disposal, and what the
// user is told. Never what those modules then do.
//
// WHY THE TWO INSTALL MODULES ARE STUBBED WHOLESALE — never spread over the real ones, and the
// real ones are never imported in this file. Two independent reasons, either one sufficient:
//   1. Running them is the opposite of the contract above: installCloudMaster binds a real TCP
//      port and installCloudWorker starts a real renewal loop.
//   2. LINK TIME. By the time this file runs inside a full `bun test`, autoswitch.test.ts has
//      already registered process-global, un-evictable PARTIAL stubs of accounts.ts and usage.ts
//      (loadAccounts / readActiveId / readAuthOpenai / accountsOf / switchToAccount /
//      collectAllUsage and nothing else). Both install modules import names those stubs do not
//      carry — writeAuthAnthropic, withAuthLock, autoCapture, fetchUsage — so importing them here
//      would fail at link time in the suite while passing when this file runs alone.
// The two stub registrations are themselves process-global; nothing else in the suite imports
// either install module, so they leak into no other file.

type MasterConfig = Extract<ModeConfig, { mode: "cloud-master" }>
type WorkerConfig = Extract<ModeConfig, { mode: "cloud-worker" }>

type Install = { module: "master" | "worker"; config: MasterConfig | WorkerConfig }

const installs: Install[] = []
const disposed: string[] = []

mock.module("../master/install.ts", () => ({
  installCloudMaster: (_api: TuiPluginApi, config: MasterConfig) => {
    installs.push({ module: "master", config })
    return {
      dispose: () => {
        disposed.push("master")
      },
    }
  },
}))

mock.module("../worker/install.ts", () => ({
  installCloudWorker: (_api: TuiPluginApi, config: WorkerConfig) => {
    installs.push({ module: "worker", config })
    return {
      dispose: () => {
        disposed.push("worker")
      },
    }
  },
}))

const { dispatchMode } = await import("./dispatch.ts")

type Harness = { api: TuiPluginApi; toasts: TuiToast[]; disposers: TuiDispose[] }

// A PARTIAL TuiPluginApi literal, the autoswitch.test.ts convention: dispatchMode reaches for
// exactly two members, and everything that would need the rest of the surface is stubbed above.
// Also resets the two shared recorders, so each test reads only its own effects.
function harness(): Harness {
  const toasts: TuiToast[] = []
  const disposers: TuiDispose[] = []
  const api = {
    ui: {
      toast: (input: TuiToast) => {
        toasts.push(input)
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (fn: TuiDispose) => {
        disposers.push(fn)
        return () => {}
      },
    },
  } as unknown as TuiPluginApi
  installs.length = 0
  disposed.length = 0
  return { api, toasts, disposers }
}

test("local config leaves bootstrap selection on the local path", () => {
  const { api, toasts, disposers } = harness()

  expect(dispatchMode(api, { mode: "local" })).toBe("local")

  // This is the EXISTING-USER UPGRADE PATH (parseMode answers `local` for absent options), so the
  // dispatcher must be invisible on it: no cloud module installed, no toast, and not even a
  // dispose registration — the caller's own bootstrap owns every one of those.
  expect(installs).toEqual([])
  expect(toasts).toEqual([])
  expect(disposers).toEqual([])
})

test("invalid config installs nothing and toasts", () => {
  const { api, toasts, disposers } = harness()
  const reason = `cloud-worker needs "poolKey" (non-empty string)`

  expect(dispatchMode(api, { mode: "invalid", reason })).toBe("handled")

  // STOP, do not fall back. A half-configured cloud install is worse than none: a worker without a
  // pool key silently reverts to refreshing chains the master owns, which is the one failure that
  // strands an account permanently. Falling through to the local bootstrap would do exactly that
  // while looking like a normal start, so `handled` with nothing installed is the whole point.
  expect(installs).toEqual([])
  expect(disposers).toEqual([])
  expect(toasts).toHaveLength(1)
  expect(toasts[0].variant).toBe("error")
  // Verbatim, because the user's only useful move is to fix the exact field parseMode named.
  expect(toasts[0].message).toContain(reason)
})

test("worker config selects worker install, master config selects master install", () => {
  const worker = harness()
  const workerConfig: WorkerConfig = {
    mode: "cloud-worker",
    masterUrl: "http://10.0.0.2:8787",
    poolKey: "pool-key-worker-1",
    workerId: "worker-1",
  }

  expect(dispatchMode(worker.api, workerConfig)).toBe("handled")
  // Exactly one entry: the CROSS-MODE assertion. A worker that also started a lease server would
  // hand out credentials it does not hold; a master that also installed the worker's lease keeper
  // would overwrite its own real chain with a lease.
  expect(installs).toEqual([{ module: "worker", config: workerConfig }])
  expect(worker.toasts).toEqual([])
  expect(worker.disposers).toHaveLength(1)
  worker.disposers[0]()
  expect(disposed).toEqual(["worker"])

  const master = harness()
  const masterConfig: MasterConfig = { mode: "cloud-master", hostname: "127.0.0.1", port: 8787 }

  expect(dispatchMode(master.api, masterConfig)).toBe("handled")
  expect(installs).toEqual([{ module: "master", config: masterConfig }])
  expect(master.toasts).toEqual([])
  expect(master.disposers).toHaveLength(1)
  master.disposers[0]()
  expect(disposed).toEqual(["master"])
})
