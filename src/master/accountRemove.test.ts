import { expect, test } from "bun:test"
import type { StoredAccount } from "../accounts.ts"
import { createAccountRemove, type AccountRemoveDeps } from "./accountRemove.ts"

// The collaborators are FAKES over an in-memory roster, not mocks returning canned answers: half of
// what this module promises is about ORDER (a copy exists before the record stops existing) and
// about a write NOT happening on the refusal paths, and neither is observable from a canned return.

const account = (id: string, label: string, extra?: Partial<StoredAccount>): StoredAccount => ({
  id,
  label,
  refresh: `refresh-${id}`,
  ...extra,
})

const ALICE = account("aaaaaaaa-1111-2222-3333-444444444444", "alice@example.test")
const BOB = account("bbbbbbbb-1111-2222-3333-444444444444", "bob@example.test")

type Harness = {
  remove: (idPrefix: string, label: string) => ReturnType<ReturnType<typeof createAccountRemove>["remove"]>
  // One entry per collaborator call, in the order they happened. The ONLY way to state "the backup
  // precedes the deletion" as an assertion rather than as a hope.
  events: string[]
  roster: StoredAccount[]
}

function harness(options?: { accounts?: StoredAccount[]; backupThrows?: boolean; vanishes?: boolean }): Harness {
  const roster = [...(options?.accounts ?? [ALICE, BOB])]
  const events: string[] = []
  const deps: AccountRemoveDeps = {
    loadAccounts: async () => roster,
    backup: async (target) => {
      events.push(`backup:${target.id}`)
      if (options?.backupThrows) throw new Error("disk said no")
    },
    remove: async (id) => {
      events.push(`remove:${id}`)
      if (options?.vanishes) return undefined
      const index = roster.findIndex((entry) => entry.id === id)
      if (index < 0) return undefined
      return roster.splice(index, 1)[0]
    },
  }
  return { remove: createAccountRemove(deps).remove, events, roster }
}

test("a unique prefix with a matching label is backed up, then deleted", async () => {
  // Given: a two-account pool
  const test1 = harness()

  // When: the operator names one row and retypes its address
  const outcome = await test1.remove("aaaaaaaa", "alice@example.test")

  // Then: it is gone, and reported with the SAME 8-char prefix the dashboard published
  expect(outcome).toEqual({ ok: true, idPrefix: "aaaaaaaa", label: "alice@example.test" })
  expect(test1.roster.map((entry) => entry.id)).toEqual([BOB.id])

  // AND THE ORDER, which is the point of this case: the copy is on disk BEFORE the only other copy
  // of that refresh token is destroyed. Reversed, there is a window in which the chain exists
  // nowhere — and Anthropic mints no replacement.
  expect(test1.events).toEqual([`backup:${ALICE.id}`, `remove:${ALICE.id}`])
})

test("an account whose refresh chain is already dead can still be deleted", async () => {
  // Given: the case that motivated this route — a record Anthropic answered invalid_grant for, so it
  // is flagged needsReauth and can never be leased again
  const dead = account("cccccccc-1111-2222-3333-444444444444", "tian@example.test", { needsReauth: true })
  const test2 = harness({ accounts: [dead] })

  // When
  const outcome = await test2.remove("cccccccc", "tian@example.test")

  // Then: removed. needsReauth and excluded are refusals on the LEASE path because serving such an
  // account cannot work; here they are the very accounts an operator is most likely to be removing,
  // so treating them as unservable would lock the pool's dead records in permanently.
  expect(outcome).toEqual({ ok: true, idPrefix: "cccccccc", label: "tian@example.test" })
  expect(test2.roster).toEqual([])
})

test("a prefix matching nothing is refused with nothing written", async () => {
  const test3 = harness()

  const outcome = await test3.remove("ffffffff", "alice@example.test")

  expect(outcome).toEqual({ ok: false, refusal: "unknown" })
  // Neither collaborator ran: a refusal must cost the pool no write at all, not even the backup.
  expect(test3.events).toEqual([])
  expect(test3.roster).toHaveLength(2)
})

test("a prefix matching two accounts is refused rather than resolved to the first", async () => {
  // Given: two records sharing the prefix the page would have shown
  const twin = account("aaaaaaaa-9999-8888-7777-666666666666", "twin@example.test")
  const test4 = harness({ accounts: [ALICE, twin] })

  // When
  const outcome = await test4.remove("aaaaaaaa", "alice@example.test")

  // Then: refused. Resolving to the first match would delete whichever record happened to sort
  // earlier, and unlike a wrong switch that cannot be undone by trying again.
  expect(outcome).toEqual({ ok: false, refusal: "ambiguous" })
  expect(test4.events).toEqual([])
  expect(test4.roster).toHaveLength(2)
})

test("a confirmation naming a different account is refused", async () => {
  // Given: the prefix of alice, the address of bob — a stale page, or a misread row
  const test5 = harness()

  const outcome = await test5.remove("aaaaaaaa", "bob@example.test")

  // Then: refused, and NOTHING is deleted — not bob (whose address was typed) and not alice (whose
  // row was pressed). The confirmation is what makes the dialog's typing step real rather than
  // browser-side ceremony.
  expect(outcome).toEqual({ ok: false, refusal: "label-mismatch" })
  expect(test5.events).toEqual([])
  expect(test5.roster).toHaveLength(2)
})

test("a ChatGPT record cannot be reached through this route", async () => {
  // Given: an openai record sharing a prefix with nothing the dashboard renders
  const chatgpt = account("dddddddd-1111-2222-3333-444444444444", "gpt@example.test", { provider: "openai" })
  const test6 = harness({ accounts: [chatgpt] })

  // When
  const outcome = await test6.remove("dddddddd", "gpt@example.test")

  // Then: unknown, as if it were not there — the pool is anthropic-only (INV-M1) and the page never
  // showed this row, so a prefix must not be able to name it.
  expect(outcome).toEqual({ ok: false, refusal: "unknown" })
  expect(test6.roster).toHaveLength(1)
})

test("a record that vanished between the lookup and the delete is reported unknown", async () => {
  // Given: a roster read that succeeds and a delete that finds nothing — another operator pressed
  // first, or the same one pressed twice
  const test7 = harness({ vanishes: true })

  const outcome = await test7.remove("aaaaaaaa", "alice@example.test")

  // Then: reported as unknown rather than as a success that removed nothing, because by the time we
  // answer that is exactly what it is.
  expect(outcome).toEqual({ ok: false, refusal: "unknown" })
})

test("a backup that cannot be written aborts the deletion", async () => {
  // Given: a disk that refuses the copy
  const test8 = harness({ backupThrows: true })

  // When/Then: the failure propagates (the server answers 500) instead of being swallowed
  await expect(test8.remove("aaaaaaaa", "alice@example.test")).rejects.toThrow("disk said no")

  // AND the account is still in the pool. Skipping an unwritable backup and deleting anyway would
  // silently drop the one guarantee that makes this button safe to press.
  expect(test8.events).toEqual([`backup:${ALICE.id}`])
  expect(test8.roster).toHaveLength(2)
})
