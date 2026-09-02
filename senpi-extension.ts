// SENPI extension entry — the cloud-worker lease loop for the senpi harness.
//
// Companion to tui.tsx (the opencode plugin entry). Same master, same lease protocol, same
// installLeaseKeeper: the ONLY thing that differs is where a leased access token lands. opencode
// reads it from auth.json; senpi reads it from CLAUDE_CODE_OAUTH_TOKEN in its own environment. See
// src/senpi/envSlot.ts for why that difference is load-bearing rather than cosmetic.
//
// SCOPE: cloud-worker, anthropic only. Local mode has no lease to keep and a master runs no senpi.
//
// Install (per senpi's extension discovery):
//   senpi -e /path/to/claude-accounts-pool/senpi-extension.ts
//   # or drop a built copy into <agentDir>/extensions/
//
// Start the worker with both of these:
//   SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION=oauth-slots
//   SENPI_NO_FALLBACK=1
//
// AN INVALID LEASE IS REPORTED AS A SUCCESSFUL TURN, AND THAT IS UPSTREAM OF THIS FILE.
// Traced on senpi 2026.8.19 by instrumenting its own prepareSlot(): the lane resolves to
// `oauth-slots`, the slot selected is ours (`{slot:"env",source:"env"}`), and the invalid token IS
// handed to the child. The Agent SDK then rejects it — isolated against
// @anthropic-ai/claude-agent-sdk directly, an invalid CLAUDE_CODE_OAUTH_TOKEN throws
// `401 OAuth access token is invalid`. But it delivers that failure as a `result` message carrying
// `subtype: "success"` with `is_error: true`, and senpi's classifier only treats a result as a
// failure when `subtype !== "success"` — so an auth failure is scored as a completed turn: no error,
// no failover, no account block.
//
// CONSEQUENCE, BOUNDED. The blind spot is only failures shaped that way, and a rate limit is NOT
// one: those arrive as `subtype: "error_during_execution"` carrying `terminal_reason` (senpi's own
// comment in sdkFailure says so), are classified, and do block the account — so rotation and
// rate-limit attribution keep working. A missed auth failure also costs nothing: the isolated SDK
// run reported `total_cost_usd: 0`, `input_tokens: 0`, `output_tokens: 0`, because the request never
// reached a model. What it does cost is progress — the account is not blocked, so the next turn
// retries the same dead lease. Treat this as a stuck-worker defect, not a billing one.
//
// STILL UNRECONCILED, and the only route by which attribution COULD be wrong: in the senpi probe
// the turn returned real content (non-zero cacheRead) even though prepareSlot reported handing over
// the invalid token, whereas the same token isolated against the SDK returned 401 with zero usage.
// senpi passes many more options than that isolation did; none were ruled out. Do not build
// attribution guarantees on this lane until that is explained.
//
// The race that this file DID own — a turn starting before the first lease landed — is fixed in the
// turn_start handler below.
import { auditSlotBlocks, blockClearScope, clearEnvSlotBlock } from "./src/senpi/authBlockClear.ts"
import { leaseLiveAccess } from "./src/senpi/deadLease.ts"
import { createEnvSlot, senpiEnvSlot } from "./src/senpi/envSlot.ts"
import { detectExternalSwitches, externalSwitchNotice } from "./src/senpi/externalSwitch.ts"
import { adoptableLease, type CachedLease, readLeaseCache, writeLeaseCache } from "./src/senpi/leaseCache.ts"
import { createLeaseJoiner } from "./src/senpi/leaseJoiner.ts"
import { createFileLogClient } from "./src/senpi/logSink.ts"
import { withSlotLock } from "./src/senpi/slotLock.ts"
import { readSlotPin, writeSlotPin } from "./src/senpi/slotPin.ts"
import { createSlotRoster } from "./src/senpi/slotRoster.ts"
import { uiIsRpcBridged } from "./src/senpi/uiBridge.ts"
import { createUsagePanel, type PanelUi } from "./src/senpi/usagePanel.ts"
import { formatStatusText, type SlotHold } from "./src/senpi/usageRows.ts"
import { resolveWorkerConfig } from "./src/senpi/workerConfig.ts"
import { initLogger, log } from "./src/logger.ts"
import { createLeaseClient } from "./src/worker/leaseClient.ts"
import { installLeaseKeeper } from "./src/worker/leaseKeeper.ts"
import { createManualSwitch } from "./src/worker/manualSwitch.ts"
import { createPinnedLease, type PinStore } from "./src/worker/pin.ts"
import { createUsageClient } from "./src/worker/usageClient.ts"

// Only the verbs this entry uses, declared structurally rather than imported: senpi is not a
// dependency of this package, and taking one on to name a few members would tie the plugin's install
// to a senpi version for no gain. Widened from `on` alone when the panel arrived — the members below
// are the ones traced in senpi 2026.8.19's own types.d.ts, and nothing here relies on the rest.
type SenpiCtx = {
  // False in `-p` and other non-interactive runs. senpi's own builtins branch on it rather than
  // opening a dialog that has nowhere to draw.
  hasUI: boolean
  ui: {
    select: (title: string, options: string[]) => Promise<string | undefined>
    notify: (message: string, type?: "info" | "warning" | "error") => void
    // Footer text, persistent until called again. There is no clearStatus in senpi's API: passing
    // undefined for the same key IS the clear.
    setStatus: (key: string, text: string | undefined) => void
  }
}

type SenpiExtensionApi = {
  // The handler's promise MATTERS: senpi's runner awaits it (`await handler(event, ctx)`), which is
  // the only thing that lets a turn wait for a lease instead of racing it.
  on: (event: "turn_start", handler: (event: unknown, ctx: SenpiCtx) => Promise<void>) => void
  // The name is registered BARE. senpi's dispatcher strips the leading slash off the typed line and
  // matches what remains, so "usage" is what makes `/usage` work — writing "/usage" here would
  // require the operator to type `//usage`.
  registerCommand: (
    name: string,
    options: { description?: string; handler: (args: string, ctx: SenpiCtx) => Promise<void> },
  ) => void
  // Lowercase, `+`-joined ("ctrl+shift+u"), NOT emacs notation — senpi's KeyId union spells it that
  // way and an unparsed key silently never fires.
  registerShortcut: (
    shortcut: string,
    options: { description?: string; handler: (ctx: SenpiCtx) => Promise<void> | void },
  ) => void
  // The ONLY channel out of the shared host daemon that reaches the operator — see uiBridge.ts. It
  // travels as a session message rather than a UI request, so it survives the RPC hop the whole
  // ctx.ui surface is dropped on. `triggerTurn: false` keeps it from starting a turn; the text does
  // enter the model's context, which is why the bridged path prints the roster and nothing else.
  sendMessage: (
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean },
  ) => void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// PROCESS-WIDE, NOT MODULE-WIDE. senpi loads extensions through jiti with `moduleCache: false` and
// calls the factory once per session, so module-level state is re-created on `/reload` and per cwd —
// a module-level guard would leak a keeper (and its interval) on every reload. A registry symbol
// survives both, because it hangs off the realm rather than the module.
const KEEPER_KEY = Symbol.for("claude-accounts-pool/senpi-lease-keeper")

// The footer key. One key for this whole extension, so the status line replaces itself instead of
// stacking a second entry per turn.
const STATUS_KEY = "claude-accounts-pool"

// Not any of ctrl+{a,c,d,f,g,l,n,o,p,r,s,t,u,v,x,z}: senpi's interactive mode already binds every one
// of those, and registering over one would shadow a working key rather than add a new one. Whether a
// terminal can even DELIVER ctrl+shift+u distinguishably from ctrl+u depends on its keyboard protocol
// — `/usage` is the surface that always answers, and this is the accelerator for terminals that can.
//
// It is also the ONLY interactive one under omo's shared RPC host: a shortcut handler runs in the TUI
// process against a live surface, while a slash command is dispatched in the daemon, where the dialog
// has nobody to answer it (uiBridge.ts). So this key stopped being a convenience there.
const PANEL_SHORTCUT = "ctrl+shift+u"

// The customType on the session message the bridged panel prints itself as. senpi shows it as the
// message's heading, so it is operator-facing text, not an internal key.
const PANEL_MESSAGE_TYPE = "账号池用量"

type QueuedToast = { variant: "warning" | "error"; message: string }

// Everything the registered surfaces need from one installed worker. `ensureLeased` is the turn gate;
// the rest is what the panel, the status line and the external-switch notice read.
type Installed = {
  ensureLeased: () => Promise<void>
  statusText: () => string
  openPanel: (ui: PanelUi) => Promise<void>
  // Keeper warnings that arrived with NO ctx to show them on. The keeper renews on an interval that
  // fires between turns, and a ctx captured to serve it would be invalidated by the next /reload and
  // then throw from every method — so the message waits here for a turn to bring a live one.
  drainToasts: () => QueuedToast[]
  followExternal: () => Promise<string[]>
  // Per-turn recovery for a slot senpi auth-blocked mid-session, plus the record of what it saw.
  auditBlocks: () => Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// A stage that must never fail a turn. senpi has no hook an extension can abort a turn from, so the
// only options are "log it" and "let it propagate and break the session" — and the second is never
// the right trade for a status line or a notice.
async function guard(event: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    log.warn(event, { error: errorMessage(error) })
  }
}

function install(masterUrl: string, workerId: string, slots: number): Installed {
  const client = createLeaseClient({
    // The real global fetch: this is the composition root for the senpi lane, and the master lives
    // on the internal network. Tests inject their own transport.
    fetchImpl: fetch,
    sleep,
    masterUrl,
    workerId,
  })

  // ONE ROSTER FOR EVERY SLOT. Each slot below runs its own keeper — that reuse is what makes the
  // fail-safe, the backoff, the stale-lease refusal and the dispose race come for free, and it gives
  // every slot an independent failure counter so one dead account cannot throttle the others. The
  // price is that K keepers install K intervals which fire at nearly the same instant, so the
  // exclusion set and the claim have to be one section owned in a single place. See slotRoster.ts.
  const roster = createSlotRoster()
  const joiners: Array<() => Promise<void>> = []
  // RETAINED, where this loop used to drop them on the floor. `heldAccountId()` is the only thing in
  // the process that knows which account a slot is on — a lease writes access and expiry and nothing
  // else — so the panel cannot mark a row, and the status line cannot name an account, without these.
  const slotUnits: {
    slotName: string
    keeper: { heldAccountId: () => string | undefined; adoptAccount: (accountId: string) => void }
    writeLease: (input: { access: string; expires: number; accountId: string }) => Promise<void>
    pin: PinStore
    // Retained for the block audit: it is what turns senpi's auth_error report into a renewal.
    invalidate: () => void
  }[] = []
  const toasts: QueuedToast[] = []
  // Filled from a switch the operator performed, which is the one moment the label and the prefix are
  // both in hand. NOT from a background fetch: resolving a label for the status line would otherwise
  // cost a master round trip on every single turn, to render a nicety. Until the first switch the
  // status shows the prefix alone, which is what the panel's own id column shows anyway.
  const labelByPrefix = new Map<string, string>()
  // READ BEFORE THE FIRST AWAIT, and published below without one. senpi decides whether this
  // provider is usable while starting a turn, which is earlier than any hook an extension can wait
  // on — so a token that only arrives when the startup lease returns is too late, and the run dies
  // with "No API key found" against a pool that is full. Measured: a master on loopback landed in
  // time, the same master across a VPN did not.
  const cached = readLeaseCache(process.env)
  const live = new Map<string, CachedLease>(cached)

  for (let index = 0; index < slots; index++) {
    const { slotName, varName } = senpiEnvSlot(index)
    const envSlot = createEnvSlot({ env: process.env, varName })

    // writeLease mutates the environment SYNCHRONOUSLY and only then resolves, so the variable is
    // already visible to senpi's availability check by the time this loop moves on. The promise
    // carries nothing worth waiting for.
    const warm = cached.get(slotName)
    if (warm) {
      void envSlot.writeLease(warm)
      // A sticky auth_error senpi persisted last session would outlive this restart and keep the
      // freshly-republished slot sidelined; drop it so the warm lease can actually be selected.
      //
      // `auth-only` here, deliberately: this republishes the very account the cache already named, so
      // a rate-limit block on the slot may well be that account's and still be real. The first
      // renewal that moves to a different account is what clears one.
      void clearEnvSlotBlock(slotName, "auth-only")
      // Recorded so the first renewal of a DIFFERENT slot excludes this account instead of being
      // handed the one this slot is already publishing.
      roster.seed(slotName, warm.accountId)
    }
    // ONE WRITE SHAPE for this slot, shared by the renewal loop and by the panel's manual switch.
    // Hoisted out of the keeper's dep object for exactly that reason: a switch that published the
    // token but forgot the cache would leave the next process cold, and a switch that forgot `live`
    // would make the NEXT renewal persist a map still naming the account we left.
    //
    // Published first, persisted second. The cache is an optimisation for the NEXT process and
    // writeLeaseCache swallows its own failures, so a disk fault can never cost this process the
    // lease it just landed.
    const writeSlotLease = async (input: { access: string; expires: number; accountId: string }): Promise<void> => {
      // MERGED FROM DISK, NEVER WRITTEN FROM `live` WHOLESALE. Several senpi hosts publish into this
      // one file, so this process's map only records what IT last wrote; persisting it verbatim drops
      // every slot another host has renewed since we started.
      const onDisk = readLeaseCache(process.env)
      // READ BEFORE THE SET BELOW: this is the only moment both the outgoing and the incoming account
      // are known, and telling a renewal-in-place from a SWAP is what decides which of senpi's blocks
      // this publish may drop. Asked of `live` — what THIS process published — and never of the cache
      // read just above, which is where the follow-external path gets its own input from. See
      // blockClearScope for what asking the cache cost.
      const scope = blockClearScope(live.get(slotName)?.accountId, input.accountId)
      await envSlot.writeLease(input)
      const entry: CachedLease = { accountId: input.accountId, access: input.access, expires: input.expires }
      live.set(slotName, entry)
      await writeLeaseCache(new Map(onDisk).set(slotName, entry))
      // A freshly published lease is the one moment this slot's token is known good, so drop any
      // block senpi pinned on it from an earlier, now-replaced token.
      await clearEnvSlotBlock(slotName, scope)
    }

    // THE PIN, ON DISK, PER SLOT, SHARED BY EVERY senpi HOST ON THIS MACHINE — slotPin.ts carries the
    // ping-pong a per-process pin produced and why persistence is the point rather than the cost. Per
    // slot rather than per worker because with K slots one may be pinned while the others rotate.
    const pin: PinStore = {
      get: () => readSlotPin(slotName, process.env),
      set: (idPrefix) => writeSlotPin(slotName, idPrefix, process.env),
    }

    // Access tokens senpi answered 401 on. The adoption below consults it because a revoked token is
    // byte-identical to a live one: the shared cache still holds the string we just invalidated, so
    // without this set the recovery would forget a dead token and adopt the very same bytes straight
    // back out of the cache — the livelock with one extra hop.
    const deadAccess = new Set<string>()
    const invalidateSlot = (): void => {
      const dropped = envSlot.invalidate()
      if (dropped !== undefined) deadAccess.add(dropped)
    }

    // The roster's section: the ONLY place a lease for this slot may be minted.
    const rosterLease = (input: {
      reason: "prelease" | "ratelimit"
      currentAccountId?: string
      preferredAccountIdPrefix?: string
      pinned?: boolean
    }) =>
      roster.withSlot(slotName, async (section) => {
        // ADOPT BEFORE ASKING — see adoptableLease for when that is allowed and why each refusal is.
        const shared = adoptableLease({
          cached: readLeaseCache(process.env),
          slotName,
          deadAccess,
          // The pin AS THIS REQUEST SAW IT, not a fresh read of the store: createPinnedLease decided
          // both fields together, and re-reading here could answer for a pin set since.
          pinnedPrefix: input.pinned === true ? input.preferredAccountIdPrefix : undefined,
          at: Date.now(),
        })
        if (shared !== undefined) {
          section.claim(shared.accountId)
          log.info("senpi:slot-lease-adopted", { slotName, accountId: shared.accountId, expires: shared.expires })
          return { ok: true, lease: { accountId: shared.accountId, access: shared.access, expiresAt: shared.expires } }
        }
        // THROUGH THE DEAD-ACCESS GUARD, never straight at the transport. The master serves its
        // CACHED access token, so leasing the account senpi just 401'd on returns the identical
        // string — and publishing it again is the livelock this whole recovery path exists to break.
        // See deadLease.ts; `deadAccess` is read live because the audit fills it mid-turn.
        const outcome = await leaseLiveAccess(
          { lease: (request) => client.lease(request), deadAccess },
          { ...input, excludeAccountIds: section.excludeAccountIds },
        )
        // Claimed only on success, and inside the section: a pick that failed to mint leaves this
        // slot on whatever it had, and recording it would make every other slot steer around a
        // hold that does not exist.
        if (outcome.ok) section.claim(outcome.lease.accountId)
        return outcome
      })

    // Its toast is queued like the keeper's, and for the same reason: dropping a pin reverses an
    // instruction the operator gave by hand, so it must be said out loud — but it happens on an
    // interval tick that holds no ctx.
    const pinnedLease = createPinnedLease({
      client: { lease: rosterLease },
      pin,
      toast: ({ variant, message }) => {
        toasts.push({ variant, message })
        log.warn("senpi:pin-toast", { slotName, message })
      },
    })

    const keeper = installLeaseKeeper({
      // PIN-AWARE, exactly as src/worker/install.ts's renewal loop is — and it has to be. The master's
      // `pinnedBy` is a property of the LEASE, so the next renewal, sending no `pinned`, overwrites
      // the record and the operator's pin is gone within one renewal cycle (≤5 min before expiry)
      // while the panel promised it would hold until the quota was spent. This wrapper re-names the
      // pinned account on every renewal, and gives the pin up on a refusal — the one path allowed to
      // abandon it, because a worker that keeps naming an account the master keeps refusing never
      // renews again. See pin.ts.
      client: { lease: pinnedLease },
      readAuth: envSlot.readAuth,
      writeLease: writeSlotLease,
      // QUEUED, not shown, and not dropped either — which is what it used to be. The keeper's
      // fail-safe message ("this worker is stranded") is user-facing in opencode via api.ui.toast,
      // but it is raised from an interval tick that owns no ctx, and senpi throws from a ctx captured
      // past its session. So it is logged AND parked for the next turn to render on a live one.
      toast: ({ variant, message }) => {
        toasts.push({ variant, message })
        if (variant === "error") log.error("senpi:lease-toast", { slotName, message })
        else log.warn("senpi:lease-toast", { slotName, message })
      },
      sleep,
      // THE MACHINE-WIDE SECTION. The roster above only serialises the slots inside THIS process, and
      // omo runs several senpi hosts that each install their own keeper against this same slot name.
      // Declining is a normal outcome, not a failure — see slotLock.ts on why a contender skips its
      // tick rather than queueing behind a lease that can legitimately take ten minutes.
      //
      // THE FILE LOCK IS TAKEN OUTSIDE THE ROSTER, here and on every other write path, and the order is
      // deliberate: acquiring it first bounds the wait to a few hundred milliseconds and never holds
      // this process's roster queue while a DIFFERENT machine's process is mid-renewal. The reverse
      // order would let one host's slow acquisition head-of-line block every other slot in here.
      section: (leaseAndPublish) => withSlotLock(slotName, leaseAndPublish),
    })
    // ADOPT THE WARM LEASE, and this is not bookkeeping — it is the only thing that makes the first
    // /usage able to mark a row. `heldAccountId` is set by a successful renewal, and when the cached
    // lease is still fresh there IS no renewal: renewalDue() says no, the keeper stays quiet, and the
    // panel then draws the account this worker is publishing as one it does not hold. Measured exactly
    // that way — the held row showed the other holders' `+1` instead of `env`. The opencode worker
    // avoids it by adopting the recorded id before its first tick (see src/worker/install.ts).
    if (warm) keeper.adoptAccount(warm.accountId)
    joiners.push(createLeaseJoiner(keeper.tickOnce))
    slotUnits.push({ slotName, keeper, writeLease: writeSlotLease, pin, invalidate: invalidateSlot })
  }

  // allSettled, NOT all: senpi selects among whatever slots currently carry a token, so one slot's
  // transport fault must not fail the turn for the slots that did renew. A rejection here would also
  // reach turn_start, where the only available response is to log — so the partial count is recorded
  // at the one place that still knows how many slots there were.
  const ensureLeased = async (): Promise<void> => {
    const settled = await Promise.allSettled(joiners.map((join) => join()))
    const failed = settled.filter((result) => result.status === "rejected").length
    if (failed > 0) log.warn("senpi:slot-lease-partial", { failed, slots: joiners.length })
  }

  // THE STARTUP LEASE, which installLeaseKeeper deliberately leaves to its caller. Nothing is
  // adopted first, unlike the opencode worker: that path inherits a previous process's auth.json
  // and must name the account it already holds, whereas an environment starts every process empty.
  // Registered through ensureLeased so the first turn JOINS this lease instead of skipping past it.
  void ensureLeased().catch((error: unknown) => log.warn("senpi:startup-lease-fail", { error: errorMessage(error) }))

  // Asked fresh every time rather than cached: a renewal or a switch moves an account between two
  // reads, and a panel drawn from a stale copy marks the row the operator just left as the one in use.
  const held = (): SlotHold[] =>
    slotUnits.map((slot) => {
      const accountId = slot.keeper.heldAccountId()
      return accountId === undefined ? { slotName: slot.slotName } : { slotName: slot.slotName, accountId }
    })

  // The panel's `enter`, for ONE slot. Everything about it is per-invocation: `ui` because a ctx must
  // never outlive its call, and createManualSwitch because its `toast` is that ctx's notify.
  //
  // THE SAME ROSTER SECTION A RENEWAL USES, and that is the whole reason this lives here rather than
  // in usagePanel.ts. K keepers renew on K intervals that fire at nearly the same instant; a switch
  // performed outside the section would compute its claim against an exclusion set another slot is
  // mid-way through changing, and two slots would end up booked on one account.
  const switchTo =
    (ui: PanelUi) =>
    async (input: {
      slotName: string
      prefix: string
      label: string
      pin: "none" | "on" | "off"
    }): Promise<void> => {
      const unit = slotUnits.find((slot) => slot.slotName === input.slotName)
      if (unit === undefined) return
      // THE LOCAL WRITE COMES FIRST, and the order is the point twice over. A renewal firing while
      // this request is in flight must already see the new intent — otherwise it asks for a ranked
      // pick and rotates the operator off the row they just pinned. And on an un-pin, clearing first
      // is what makes the local state correct even if the master never answers.
      //
      // A PLAIN SWITCH CLEARS THE PIN TOO, which is not cosmetic: leaving a pin on the account being
      // left would have the next renewal re-name it and drag the operator straight back.
      unit.pin.set(input.pin === "on" ? input.prefix : undefined)
      const manual = createManualSwitch({
        client: {
          // No excludeAccountIds: this request NAMES an account, and the master short-circuits its
          // ranking for a named one — an exclusion it does not consult would be noise on the wire.
          lease: (leaseInput) =>
            roster.withSlot(input.slotName, async (section) => {
              const outcome = await client.lease(leaseInput)
              if (outcome.ok) section.claim(outcome.lease.accountId)
              return outcome
            }),
        },
        writeLease: unit.writeLease,
        // manualSwitch owns every sentence this path can produce — success, each refusal, the
        // version-skew guard — so mapping variants is all that is left. `success` becomes `info`
        // because senpi has no success level.
        toast: ({ variant, message }) => ui.notify(message, variant === "success" ? "info" : variant),
      })
      // THE MACHINE-WIDE SECTION, the same lock and the same ordering the renewal loop uses. This path
      // leases and publishes exactly as a renewal does, so a switch left outside it would race another
      // host's renewal and one of the two publishes would be lost — which is the whole defect.
      let switched: Awaited<ReturnType<typeof manual.switchTo>> | undefined
      const held = await withSlotLock(input.slotName, async () => {
        switched = await manual.switchTo({
          prefix: input.prefix,
          label: input.label,
          // OMITTED for a plain switch. manualSwitch's `pin` is three-state and a bare `false` is an
          // UNPIN there — passing it for every switch is what made the panel announce "已取消钉住"
          // to somebody who had never pinned anything.
          ...(input.pin === "none" ? {} : { pin: input.pin === "on" }),
        })
      })
      if (!held) {
        // SAID OUT LOUD, unlike a declined renewal tick: the operator pressed a key and is waiting for
        // an answer, so "nothing happened" has to be an answer rather than silence. The pin goes back
        // for the same reason a refusal drops it — it now describes an intent no lease acted on.
        if (input.pin === "on") unit.pin.set(undefined)
        ui.notify("这个槽位正被另一个 senpi 进程续租，请稍后重试", "warning")
        return
      }
      if (switched === undefined || !switched.ok) {
        // A pin the master would not serve must not survive as a standing instruction: every renewal
        // from here would name it, be refused, and fall back — one wasted round trip per cycle for an
        // account the operator has already been told is unavailable.
        if (input.pin === "on") unit.pin.set(undefined)
        return
      }
      // The renewal loop performed no lease, so it would otherwise keep naming the account we just
      // left as the one we hold — and that id is the master's rotation anchor.
      unit.keeper.adoptAccount(switched.accountId)
      labelByPrefix.set(input.prefix, input.label)
    }

  const usage = createUsageClient({ fetchImpl: fetch, masterUrl })

  return {
    ensureLeased,
    statusText: () => formatStatusText({ held: held(), labelByPrefix }),
    // CLEARING THE BLOCK IS ONLY HALF THE RECOVERY. senpi blocked the slot after a 401, so the token
    // this process published is dead — and a revoked token is indistinguishable from a live one here
    // (same bytes, horizon still in the future), so the block IS the evidence. Clearing alone puts that
    // dead token straight back into selection; senpi re-blocks it, and the pair oscillates for the rest
    // of the session. Invalidating drops the remembered lease, so the ensureLeased() that follows in
    // this same turn leases a live one.
    auditBlocks: async (): Promise<void> => {
      const authBlocked = await auditSlotBlocks(slotUnits.map((slot) => slot.slotName))
      for (const slotName of authBlocked) slotUnits.find((slot) => slot.slotName === slotName)?.invalidate()
    },
    drainToasts: () => toasts.splice(0, toasts.length),
    openPanel: (ui) =>
      createUsagePanel({
        usage,
        switchTo: switchTo(ui),
        slots: slotUnits.map((slot) => slot.slotName),
        held,
        pinnedSlots: (idPrefix) => slotUnits.filter((slot) => slot.pin.get() === idPrefix).map((slot) => slot.slotName),
        // process.stdout IS the terminal senpi renders into, so its column count is the real budget.
        // Undefined on a pipe or a non-tty, which formatAccountRows reads as "no constraint".
        terminalWidth: () => process.stdout.columns,
        now: () => Date.now(),
        workerId,
      }).open(ui),
    // ADOPT, not merely announce. The account this process still publishes may already have been
    // handed to somebody else, and the master's rotation anchor for this workerId has moved with the
    // lease that did it — so staying put means renewing against an anchor the master has left behind.
    // Inside the roster section for the same reason a switch is.
    followExternal: async (): Promise<string[]> => {
      const moved = detectExternalSwitches({ cached: readLeaseCache(process.env), held: held() })
      const notices: string[] = []
      for (const change of moved) {
        const unit = slotUnits.find((slot) => slot.slotName === change.slotName)
        if (unit === undefined) continue
        // UNDER THE MACHINE-WIDE LOCK TOO, because this republishes into the shared cache. A decline is
        // simply skipped and left unannounced: this runs on every turn, the host that holds the lock is
        // mid-renewal on this very slot, and the next turn reads whatever it published.
        const adopted = await withSlotLock(change.slotName, () =>
          roster.withSlot(change.slotName, async (section) => {
            section.claim(change.to.accountId)
            await unit.writeLease(change.to)
            unit.keeper.adoptAccount(change.to.accountId)
          }),
        )
        if (adopted) notices.push(externalSwitchNotice(change))
      }
      return notices
    },
  }
}

export default function claudeAccountsPoolSenpiExtension(pi: SenpiExtensionApi): void {
  // Stored config with CAP_* taking precedence, so a plain `omo` works on a machine that was
  // configured once and an environment variable still overrides it for a single run. Reading the
  // environment alone is what made a bare `omo` return here and leave the warm lease on disk
  // unpublished — the pool was full and the run died with "No models available".
  const config = resolveWorkerConfig(process.env)
  // Silent, not a warning: this same file is a no-op on a developer's laptop and on the master
  // itself, and an extension that complained on every unrelated senpi start would be uninstalled.
  if (!config) return

  // AFTER the config gate, so a machine that is not a pool worker never gets a log file it did not
  // ask for. Everything below reports through guard(), which discards its error when no client is
  // installed — this call is what makes the rest of this file diagnosable at all.
  initLogger(createFileLogClient(process.env))

  const registry = globalThis as Record<PropertyKey, unknown>
  const existing = registry[KEEPER_KEY] as Installed | undefined
  const installed = existing ?? install(config.masterUrl, config.workerId, config.slots ?? 1)
  registry[KEEPER_KEY] = installed

  // AWAITED, NOT FIRE-AND-FORGET — this is the whole reason the lane works. managedPool() reads
  // CLAUDE_CODE_OAUTH_TOKEN at the top of every query and, finding none, returns undefined; the
  // provider then takes its `ambient` branch, which passes the parent environment straight through
  // and lets the spawned `claude` fall back to whatever credential the machine itself holds. The
  // turn succeeds, reports `provider: "claude-sdk-oauth"`, raises no error — and was charged to an
  // account the pool never leased. Returning this promise is what makes the turn wait for the token
  // instead of overtaking it. `SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION=oauth-slots` cannot cover for
  // it: the ambient fallback is gated on `accounts.length === 0`, not on the configured lane.
  //
  // `pi` IS NOT CAPTURED. senpi invalidates a captured extension ctx after a session replacement or
  // /reload and then throws from every method on it — so anything that outlives this call (the
  // keeper, its interval) must never hold one. Renewal needs only the environment and the master.
  //
  // The catch is deliberate and its consequence is the residual hazard: a turn is never failed on
  // this extension's behalf, because no supported hook can abort one. A worker that cannot lease
  // therefore still runs — on ambient credentials — and only the log says so.
  pi.on("turn_start", async (_event, ctx) => {
    // BEFORE the lease, not after. Adopting first is what makes the renewal below name the account we
    // actually hold as `currentAccountId` — the master's rotation anchor — instead of the one another
    // process moved us off.
    await guard("senpi:turn-prelude", async () => {
      for (const parked of installed.drainToasts()) ctx.ui.notify(parked.message, parked.variant)
      for (const notice of await installed.followExternal()) ctx.ui.notify(notice, "warning")
    })
    // BEFORE the lease, and that ordering is the fix: a slot senpi auth-blocked mid-session is
    // selectable again for THIS turn rather than from the next renewal — which is LEASE_RENEW_BUFFER_MS
    // before expiry, i.e. hours away, and a warm lease is not due for renewal so the lease below would
    // do nothing on its own. On a worker with no stored login account one blocked slot IS senpi's "All
    // Claude accounts are currently blocked", whose advice to re-login cannot apply: a pool-fed env slot
    // has no login. The audit also invalidates every slot it unblocks, which is what makes the lease
    // below replace the dead token rather than republish it.
    await guard("senpi:turn-block-audit", () => installed.auditBlocks())
    await installed
      .ensureLeased()
      .catch((error: unknown) => log.error("senpi:turn-lease-fail", { error: errorMessage(error) }))
    // LAST, so it reports the lease this turn actually got. Its own stage because a footer is never
    // worth failing a turn over, and a lease failure must still leave the line truthful.
    await guard("senpi:turn-status", () => {
      ctx.ui.setStatus(STATUS_KEY, installed.statusText())
      return Promise.resolve()
    })
  })

  // The methods are re-wrapped rather than passed as references. `ctx.ui.select` detached from `ctx.ui`
  // loses its receiver, and senpi's implementation is a method on a live TUI object — an unbound call
  // is the kind of failure that only appears in the real terminal.
  //
  // On the RPC bridge the panel is declared UI-LESS even though `ctx.hasUI` says otherwise, which is
  // what routes it down usagePanel's existing `-p` branch: print the roster once and return, never
  // opening the dialog that would hang there forever. The accelerator is the interactive half, and it
  // runs in the TUI process where the same wrapper hands back the real surface.
  const panelSurface = (ctx: SenpiCtx): PanelUi => {
    const bridged = uiIsRpcBridged(process.argv)
    return {
      hasUI: ctx.hasUI && !bridged,
      select: (title, options) => ctx.ui.select(title, options),
      notify: (message, type) => {
        if (!bridged) {
          ctx.ui.notify(message, type)
          return
        }
        // usagePanel notifies the roster bare and every failure with a severity, so an absent `type`
        // IS the roster — the one message the accelerator hint belongs on. Appending it to "master
        // 不可达" would advise a key that opens a panel which cannot load either.
        const hint = `\n\n交互面板（切号 / 钉号）按 ${PANEL_SHORTCUT} 打开：这个会话跑在共享 RPC 宿主里，扩展的对话框在那条链路上无人应答。`
        pi.sendMessage(
          { customType: PANEL_MESSAGE_TYPE, content: type === undefined ? `${message}${hint}` : message, display: true },
          { triggerTurn: false },
        )
      },
    }
  }

  const openPanel = async (ctx: SenpiCtx): Promise<void> => {
    await installed.openPanel(panelSurface(ctx))
    // Refreshed on the way OUT, so a switch the operator just made is on the footer before the dialog
    // has finished closing. It also covers the case turn_start alone cannot: a session where nobody
    // has sent a message yet has run no turn, so opening the panel is the first moment this line can
    // exist at all — and "which account am I on" is exactly the question that opened it.
    ctx.ui.setStatus(STATUS_KEY, installed.statusText())
  }

  // Registered per factory call, unlike the keeper above: senpi builds a fresh extension instance per
  // session and its command map lives on that instance, so this is a registration into this session
  // rather than process-wide state to guard against duplicating.
  pi.registerCommand("usage", {
    description: "账号池用量：查看池内账号、切换或钉住当前账号",
    handler: (_args, ctx) => {
      // THE PAIR IS THE POINT. `/usage` has failed twice with nothing on disk to say which half broke,
      // and the two halves need opposite fixes: senpi renames same-named commands to `usage:1`/`usage:2`,
      // so a second copy of this extension in one session's runner leaves bare `/usage` matching nothing
      // and this line never runs — while a registration that never happened leaves the line above missing
      // too. One log tells them apart; neither can be inferred from the panel not appearing.
      log.info("senpi:usage-dispatched", { hasUI: ctx.hasUI })
      return guard("senpi:usage-command", () => openPanel(ctx))
    },
  })
  log.info("senpi:usage-registered")

  pi.registerShortcut(PANEL_SHORTCUT, {
    description: "打开账号池用量面板",
    handler: (ctx) => guard("senpi:usage-shortcut", () => openPanel(ctx)),
  })
}
