// Joins the three things a master ALREADY knows — the account roster, the usage poller's latest
// snapshot, and the scheduler's cooldown verdict — into the one payload the read-only dashboard
// renders. It introduces NO data source of its own: the whole point of the dashboard is that
// `/api/oauth/usage` is already being polled on a schedule this endpoint may not perturb.
//
// A separate module from leaseServer.ts so the join is testable without a socket, and from
// scheduler.ts so the scheduler keeps owning selection and nothing else.
//
// PRIVACY: this file never reads `account.access` or `account.refresh`, and UsageAccountView has
// nowhere to put them. Both halves of that are load-bearing — see the header on the view types.

import { providerOf, type StoredAccount } from "../accounts.ts"
import type { UsageAccountView, UsageSnapshotView, UsageWindowView } from "../cloud/protocol.ts"
import { PROVIDERS, type NormalizedWindow } from "../providers.ts"
import type { UsageSnapshot } from "./scheduler.ts"

// Eight hex chars of a uuid: enough to eyeball against a log line, far short of the id itself.
const ID_PREFIX_LENGTH = 8

export type UsageViewInput = {
  accounts: StoredAccount[]
  snapshot: UsageSnapshot
  isCoolingDown: (accountId: string) => boolean
  holdersOf: (accountId: string) => string[]
}

// `typeof === "string"`, NOT `!== undefined`. MEASURED against the live endpoint: a window sitting at
// 0% comes back as `resets_at: null`, and that value reaches us through fetchUsage's unvalidated
// `as UsageResponse` cast — so the declared `string | undefined` is a claim, not a guarantee. An
// undefined-check would put `"resetsAt": null` on the wire, contradicting a view type that promises
// the field is either absent or a string, and misleading any consumer testing with `in`.
function toWindowView(window: NormalizedWindow): UsageWindowView {
  return {
    label: window.label,
    utilization: window.utilization,
    ...(typeof window.resets_at === "string" ? { resetsAt: window.resets_at } : {}),
  }
}

export function buildUsageView(input: UsageViewInput): UsageSnapshotView {
  const accounts: UsageAccountView[] = []
  for (const account of input.accounts) {
    // ANTHROPIC-only through providerOf (INV-M1/INV-P1), for the same reason the poller and the
    // scheduler are: `/api/oauth/usage` is Anthropic's endpoint, so a ChatGPT record could never
    // hold a snapshot entry and would render as a permanently unknown row. Read through providerOf
    // — a hand-rolled `provider === "anthropic"` drops every pre-multi-provider record.
    if (providerOf(account) !== "anthropic") continue
    const usage = input.snapshot.byId.get(account.id)
    accounts.push({
      idPrefix: account.id.slice(0, ID_PREFIX_LENGTH),
      label: account.label,
      windows: usage ? PROVIDERS.anthropic.normalize(usage).map(toWindowView) : [],
      hasUsage: usage !== undefined,
      coolingDown: input.isCoolingDown(account.id),
      excluded: account.excluded === true,
      needsReauth: account.needsReauth === true,
      // ALWAYS present, empty when nobody holds it: the page has to tell "no worker is on this account"
      // apart from "this master cannot say", and only an omitted field may mean the latter.
      holders: input.holdersOf(account.id),
      ...(account.expires === undefined ? {} : { expiresAt: account.expires }),
    })
  }
  // Row order is the ROSTER's order, deliberately not sorted by utilization: the operator scans the
  // same list in the same positions on every refresh, and a self-reordering table makes a pool that
  // is merely rotating look like one that is churning.
  return { at: input.snapshot.at, stale: input.snapshot.stale, accounts }
}
