import { NETWORK_TIMEOUT_MS, OAUTH_BETA, PROFILE_ENDPOINT } from "./constants.ts"
import { log } from "./logger.ts"

// The plan-bearing fields of oauth/profile's `organization`, kept VERBATIM instead of
// pre-formatted into a label. Two reasons: the value domain is only partly confirmed (see
// planLabel), so a later mapping fix must not require re-fetching every account; and an
// EMPTY object is itself meaningful — it records "profile was read, it carried no
// organization", which is what stops a plan-less account from being re-fetched on every
// single /usage. Absent (undefined) means never looked up; `{}` means looked up and empty.
export type Subscription = {
  organizationType?: string
  seatTier?: string
  rateLimitTier?: string
}

export type Profile = {
  uuid: string
  email: string
  displayName: string
  subscription: Subscription
}

// Only values with real-world evidence get a branded name; anything else is passed through
// VERBATIM. This endpoint is undocumented, so inventing a label for an unconfirmed value would
// print a plan the user does not own — showing the raw string is both the honest failure mode
// and the channel through which an unknown value gets reported back to us.
//
// EVIDENCE (2026-07): `claude_team` and `claude_max` are confirmed by real captured payloads
// (ours, and jens-duttke/usage-monitor-for-claude's March 2026 Max capture). `claude_max` +
// `default_claude_max_20x` are additionally confirmed by Claude Code's own CLI source, which
// branches on exactly these two strings to detect Max 20x. `claude_enterprise` is hardcoded by
// Wei-Shaw/claude-relay-service, a production relay handling real enterprise accounts.
// `claude_pro` is the one INFERRED entry — no captured Pro payload was found, only test
// fixtures — but the `claude_<plan>` naming of the three confirmed siblings makes it the
// overwhelmingly likely value, and a wrong guess degrades to passthrough rather than a lie.
const ORG_TYPE_LABEL: Record<string, string> = {
  claude_pro: "Pro",
  claude_max: "Max",
  claude_team: "Team",
  claude_enterprise: "Enterprise",
}

// Anthropic's public pricing calls the two Team seats "Standard" and "Premium" (Premium being
// the one that includes Claude Code). `team_tier_1` = Premium is confirmed by the maintainer's
// own Team account plus two independent OSS projects mapping it the same way. A `team_tier_2`
// appears in exactly ONE project, labelled only with a literal restatement rather than a brand
// name — a defensive placeholder, not an observed value — so it is deliberately NOT mapped here
// and will render as its raw string if it ever shows up.
const SEAT_TIER_LABEL: Record<string, string> = {
  team_standard: "Standard",
  team_tier_1: "Premium",
}

// Renders the subscription as e.g. "Pro", "Max.20x", "Team.Premium", or undefined when the
// account was never looked up / carried no organization.
export function planLabel(subscription?: Subscription): string | undefined {
  const orgType = subscription?.organizationType
  if (!orgType) return undefined
  const plan = ORG_TYPE_LABEL[orgType] ?? orgType

  // Team is priced per SEAT, so the seat is the tier that matters — and the org's
  // `rate_limit_tier` provably is not: a Team org and a personal Max account were both observed
  // reporting the same `default_claude_max_5x`. Never derive a Team's tier from that field.
  if (orgType === "claude_team") {
    const seat = subscription.seatTier
    if (!seat) return plan
    return `${plan}.${SEAT_TIER_LABEL[seat] ?? seat}`
  }

  // Max alone is sold at two multipliers (5x / 20x) at different prices, and the multiplier
  // appears nowhere but this field. Restricted to Max on purpose: no other plan is known to
  // encode a meaningful multiplier here, so widening this would attach a suffix we cannot
  // vouch for to plans that do not have one.
  if (orgType === "claude_max") {
    const multiplier = subscription.rateLimitTier?.match(/_(\d+x)$/)?.[1]
    if (multiplier) return `${plan}.${multiplier}`
  }
  return plan
}

// Tolerant by construction: every field is optional and a malformed/absent organization yields
// `{}` rather than throwing. A profile call that succeeded must never fail over a cosmetic
// badge — its real job is supplying the account uuid.
function subscriptionOf(organization: unknown): Subscription {
  if (typeof organization !== "object" || organization === null) return {}
  const org = organization as Record<string, unknown>
  const pick = (key: string): string | undefined => {
    const value = org[key]
    return typeof value === "string" && value.length > 0 ? value : undefined
  }
  return {
    organizationType: pick("organization_type"),
    seatTier: pick("seat_tier"),
    rateLimitTier: pick("rate_limit_tier"),
  }
}

export async function fetchProfile(access: string): Promise<Profile> {
  log.debug("profile:fetch-start")
  const res = await fetch(PROFILE_ENDPOINT, {
    headers: { Authorization: `Bearer ${access}`, "anthropic-beta": OAUTH_BETA },
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  })
  if (!res.ok) {
    log.warn("profile:fetch-fail", { status: res.status })
    throw new Error(`profile request failed (${res.status})`)
  }

  const json = (await res.json()) as {
    account?: { uuid?: string; email?: string; display_name?: string; full_name?: string }
    organization?: unknown
  }
  const account = json.account
  if (!account?.uuid) {
    log.warn("profile:no-uuid")
    throw new Error("profile response missing account uuid")
  }

  const profile = {
    uuid: account.uuid,
    email: account.email ?? account.uuid,
    displayName: account.display_name ?? account.full_name ?? account.email ?? account.uuid,
    subscription: subscriptionOf(json.organization),
  }
  log.info("profile:fetch-ok", { uuid: profile.uuid, email: profile.email, plan: planLabel(profile.subscription) })
  return profile
}
