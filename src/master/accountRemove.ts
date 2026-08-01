// Browser-driven removal: turn the prefix + label a dashboard row published back into ONE account
// and take it out of the pool.
//
// WHY THIS IS A MODULE AND NOT FOUR LINES IN leaseServer.ts. The lease server owns no policy — see
// its header — and every decision below is policy: which records a prefix may name, what makes a
// confirmation valid, and what has to be on disk before the destructive write. Keeping them here
// also makes them testable without a socket.
//
// NOTHING HERE TOUCHES THE DISK. `loadAccounts`, `backup` and `remove` are injected for the same
// reason nothing in AccountOnboardDeps has a default: the real `remove` deletes a live refresh token
// from the operator's account library, and a default-constructed collaborator in a test would do it
// for real. install.ts is the only file that supplies the live implementations.

import { providerOf, type StoredAccount } from "../accounts.ts"
import type { AccountDeleteRefusal } from "../cloud/protocol.ts"
import { log } from "../logger.ts"

// Eight hex chars, matching usageView's redaction and accountOnboard's echo, so a row on the page, a
// log line and this answer all name an account the same way.
const ID_PREFIX_LENGTH = 8

export type RemoveOutcome = { ok: true; idPrefix: string; label: string } | { ok: false; refusal: AccountDeleteRefusal }

export type AccountRemoveDeps = {
  loadAccounts: () => Promise<StoredAccount[]>
  // Files a recoverable copy of the record. Runs BEFORE the deletion and is allowed to THROW: a
  // backup that could not be written must abort the delete rather than be skipped quietly, because
  // the promise this flow makes to the operator is that the mistake is undoable.
  backup: (account: StoredAccount) => Promise<void>
  // Deletes by full id and hands back what was removed, or undefined if the record had already gone.
  // Takes the cross-process auth lock in production, which is why it is one injected step rather
  // than a load/modify/save this module drives itself.
  remove: (id: string) => Promise<StoredAccount | undefined>
}

export type AccountRemove = {
  remove: (idPrefix: string, label: string) => Promise<RemoveOutcome>
}

export function createAccountRemove(deps: AccountRemoveDeps): AccountRemove {
  async function remove(idPrefix: string, label: string): Promise<RemoveOutcome> {
    const accounts = await deps.loadAccounts()
    // ANTHROPIC-only through providerOf, exactly as pickPreferred (INV-M1): the dashboard renders no
    // other provider, so a prefix must not be able to reach a ChatGPT record the operator was never
    // shown — and reading through providerOf rather than `provider === "anthropic"` is what keeps
    // every pre-multi-provider record in scope.
    const matches = accounts.filter((account) => providerOf(account) === "anthropic" && account.id.startsWith(idPrefix))
    if (matches.length === 0) return { ok: false, refusal: "unknown" }
    // Refused, NOT resolved to the first match — pickPreferred's rule, and the stakes here are
    // strictly higher: a wrong switch is undone by switching back, a wrong deletion is not.
    if (matches.length > 1) return { ok: false, refusal: "ambiguous" }
    const account = matches[0]
    // The confirmation. An operator who typed a different address than the row they pressed did not
    // confirm THIS deletion, and the page may also simply be out of date — the two are
    // indistinguishable from here, and neither is safe to resolve by guessing.
    if (account.label !== label) {
      log.warn("master:account-delete-label-mismatch", { idPrefix })
      return { ok: false, refusal: "label-mismatch" }
    }
    // BEFORE the destructive write, and deliberately not after it: `remove` hands the record back, so
    // backing up afterwards would be equally complete but would leave a window in which the only copy
    // of this refresh token existed nowhere. A throw here aborts the whole thing with nothing deleted.
    await deps.backup(account)
    const removed = await deps.remove(account.id)
    // Gone between the roster read and the delete — another operator's press, or the same one twice.
    // Reported as `unknown` because that is now true, rather than as a success that removed nothing.
    if (!removed) {
      log.warn("master:account-delete-vanished", { idPrefix })
      return { ok: false, refusal: "unknown" }
    }
    // The label is already on the dashboard for every account in the pool, so logging it adds no
    // disclosure. The record's token fields are never named.
    log.info("master:account-deleted", { id: removed.id, label: removed.label })
    return { ok: true, idPrefix: removed.id.slice(0, ID_PREFIX_LENGTH), label: removed.label }
  }

  return { remove }
}
