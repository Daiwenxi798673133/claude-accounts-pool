// Did somebody ELSE move this worker's account while the process was running?
//
// THE ONLY CROSS-PROCESS SIGNAL THERE IS. A lease lives in two places: the environment variable this
// process publishes (invisible to everyone else — a child's environment cannot be written from
// outside) and the warm cache on disk, which every holder of this pool's state directory writes.
// So the cache is the one place a switch performed by a second senpi, or by hand, can become visible
// here at all. There is no event, no socket and no inotify watch: the extension reads
// the cache at the top of each turn and compares.
//
// WHY ADOPT RATHER THAN MERELY WARN. The account this process still publishes may have been handed
// to somebody else in the meantime, and the master's rotation anchor for this workerId is now the
// NEW account — so continuing on the old token means renewing against an anchor the master has
// already moved. Following the cache is what keeps this process and the master describing the same
// lease. A warning without an adoption would be a notice that the operator can do nothing about.
//
// PURE, DELIBERATELY. Detection is a comparison of two lists and nothing else: no clock (readLeaseCache
// has already dropped expired entries), no I/O, no environment. The extension owns the acting — claim,
// publish, adopt — because only it holds the roster section those three must happen inside.
import type { CachedLease } from "./leaseCache.ts"

export type ExternalSwitch = {
  slotName: string
  // The account this process was on. Never optional in practice — a slot holding nothing is not a
  // switch (see below) — but carried so the notice can name both ends.
  from: string
  to: CachedLease
}

export function detectExternalSwitches(input: {
  cached: ReadonlyMap<string, CachedLease>
  // The slots this process actually runs, and what each one currently holds. Iterated in THIS order
  // rather than over the cache: a cache written by a launch with more slots than this one carries
  // entries with no keeper and no environment variable behind them, and adopting one would book an
  // account that nothing in this process can ever spend.
  held: readonly { slotName: string; accountId?: string }[]
}): ExternalSwitch[] {
  const switches: ExternalSwitch[] = []
  for (const slot of input.held) {
    // A slot holding nothing is the COLD START, not a switch. installLeaseKeeper's startup lease is
    // already in flight for it; adopting here would race that for no gain, and the warm-cache publish
    // at install time has already handled the case where disk had something usable.
    if (slot.accountId === undefined) continue
    const cached = input.cached.get(slot.slotName)
    // No usable entry on disk is NO EVIDENCE, and must never clear a live lease: readLeaseCache
    // reports an unreadable file, a wrong version and an expired entry all as absence, so treating
    // absence as "switched to nothing" would drop a working lease over a disk hiccup.
    if (cached === undefined) continue
    if (cached.accountId === slot.accountId) continue
    switches.push({ slotName: slot.slotName, from: slot.accountId, to: cached })
  }
  return switches
}

// EIGHT CHARACTERS, matching the panel's id column and the master's own `idPrefix`. The operator
// reads this notice with the panel's account list in mind, so the two surfaces have to name an
// account the same way; a 36-char uuid here matches nothing they can see.
const SHORT_ID_LENGTH = 8

function shortId(accountId: string): string {
  return accountId.slice(0, SHORT_ID_LENGTH)
}

export function externalSwitchNotice(input: ExternalSwitch): string {
  // The slot is named unconditionally rather than only when K>1: this function cannot see how many
  // slots there are, and a notice whose shape changes with a setting is harder to recognise than one
  // extra word.
  return `外部切号（槽位 ${input.slotName}）：${shortId(input.from)} → ${shortId(input.to.accountId)}，已跟随`
}
