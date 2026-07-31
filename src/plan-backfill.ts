import { accountsOf, loadAccounts, saveAccounts, withAuthLock, type StoredAccount } from "./accounts.ts"
import { TOKEN_EXPIRY_BUFFER_MS } from "./constants.ts"
import { log } from "./logger.ts"
import { fetchProfile, type Subscription } from "./profile.ts"

async function persist(id: string, subscription: Subscription): Promise<void> {
  await withAuthLock(async () => {
    const file = await loadAccounts()
    const account = file.accounts.find((item) => item.id === id)
    if (!account) return
    account.subscription = subscription
    await saveAccounts(file)
  })
}

// Deliberately does NOT refresh anything. This runs right after collectAllUsage, which has just
// refreshed every inactive account it could, so a still-stale token here means that account was
// unreachable this round — and spending a one-shot rotating refresh token on a cosmetic badge is
// not a trade worth making. Such an account is simply skipped and retried next round.
function usableAccess(account: StoredAccount): string | undefined {
  if (!account.access || !account.expires) return undefined
  return account.expires >= Date.now() + TOKEN_EXPIRY_BUFFER_MS ? account.access : undefined
}

// One-time-per-account plan lookup for the accounts autoCapture cannot reach. autoCapture already
// records the ACTIVE account's plan for free (it fetches that profile anyway), so only inactive
// records are considered here, and only those never looked up before — see StoredAccount.
// subscription's three states. Fully best-effort: it runs after the panel is already populated,
// every failure is swallowed per account, and the badge simply appears on a later open.
export async function backfillClaudePlans(): Promise<void> {
  const file = await loadAccounts()
  const targets = accountsOf(file, "anthropic").filter(
    (account) => account.id !== file.activeId && account.subscription === undefined && !account.needsReauth,
  )
  if (targets.length === 0) return

  for (const account of targets) {
    const access = usableAccess(account)
    if (!access) continue
    try {
      const profile = await fetchProfile(access)
      await persist(account.id, profile.subscription)
    } catch (error) {
      log.debug("plan-backfill:fail", { label: account.label, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
