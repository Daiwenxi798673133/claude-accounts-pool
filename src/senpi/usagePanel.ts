// The /usage panel's control flow, for senpi. Everything it touches is injected, so the whole dialog
// is drivable from a test — which is the only way it can be: senpi's real dialog blocks on a terminal.
//
// TWO LEVELS, BECAUSE THE SURFACE ALLOWS ONE CHOICE. opencode's panel is a grid with `enter`, `p` and
// `r` bound to three different things at once; senpi offers `ui.select(title, options)` and nothing
// else, so the second key becomes a second dialog: pick an account, then pick what to do with it.
// Collapsing the two into one flat list (`切换到 A`, `钉住 A`, `切换到 B`, …) was the alternative and it
// scales to 2N options for N accounts, which at eleven accounts is a list nobody can read.
//
// THE ROW STRING IS THE HANDLE. `ui.select` resolves to the chosen STRING, so this file never works
// with indices — it looks the choice up in the map usageRows built. An index would break the moment a
// refresh reordered the roster under the operator, and a label lookup breaks on two accounts sharing
// an email. See usageRows.ts for why the row's first column is the id.
//
// `ctx` IS PASSED PER CALL AND NEVER STORED. senpi invalidates an extension ctx after a session
// replacement or /reload, and then every method on it throws — so `open(ui)` takes the surface as an
// argument and the panel keeps nothing that outlives the invocation.
import type { UsageFetchOutcome } from "../worker/usageClient.ts"
import { usageFailureMessage } from "../worker/usageClient.ts"
import { formatAccountRows, formatSwitchActions, panelTitle, REFRESH_ROW, type SlotHold } from "./usageRows.ts"

export type PanelUi = {
  // False in `-p` and other non-interactive runs: there is no dialog surface at all, and senpi's own
  // builtins answer that by notifying the same text instead of silently doing nothing.
  hasUI: boolean
  select: (title: string, options: string[]) => Promise<string | undefined>
  notify: (message: string, type?: "info" | "warning" | "error") => void
}

export type UsagePanelDeps = {
  // Read-only transport over the MASTER's already-polled snapshot. A worker never calls Anthropic's
  // usage endpoint itself — see usageClient.ts for why that indirection is the whole point.
  usage: { fetchSnapshot: () => Promise<UsageFetchOutcome>; refreshSnapshot: () => Promise<UsageFetchOutcome> }
  // Performs the lease and reports its own outcome. NOT a function of this module: a switch has to
  // happen inside the slot roster's critical section and write three places in a fixed order, all of
  // which belong to the extension's composition root.
  switchTo: (input: { slotName: string; prefix: string; label: string; pin: boolean }) => Promise<void>
  slots: readonly string[]
  // A GETTER, not a snapshot: the held set changes when a switch lands, and a panel that kept its
  // opening value would redraw the row the operator just left as the one still in use.
  held: () => readonly SlotHold[]
  workerId: string
}

export function createUsagePanel(deps: UsagePanelDeps): { open: (ui: PanelUi) => Promise<void> } {
  async function open(ui: PanelUi): Promise<void> {
    const opened = await deps.usage.fetchSnapshot()
    // A pool we cannot reach must SAY so and stop. Opening an empty dialog would read as "the pool has
    // no accounts", which is a different and far more alarming fact than "the master is unreachable".
    if (!opened.ok) {
      ui.notify(usageFailureMessage(opened.failure), "error")
      return
    }
    let view = opened.view

    // Unbounded on purpose — every iteration is gated on a human answering a dialog, and the two exits
    // that are not a switch (cancel at either level) both return. `返回` and a refresh continue.
    for (;;) {
      const { rows, accountByRow } = formatAccountRows({ view, held: deps.held(), workerId: deps.workerId })
      const title = panelTitle(view)
      if (!ui.hasUI) {
        // The refresh row is dropped: it is a control, and printing it where nothing can be selected
        // would offer an action that does not exist here.
        ui.notify([title, ...rows.filter((row) => row !== REFRESH_ROW)].join("\n"))
        return
      }

      const chosen = await ui.select(title, rows)
      // Escape, or a timeout. The ONLY correct response is silence: a toast on cancel punishes the
      // operator for closing a dialog they opened in order to look at it.
      if (chosen === undefined) return

      if (chosen === REFRESH_ROW) {
        const refreshed = await deps.usage.refreshSnapshot()
        if (refreshed.ok) view = refreshed.view
        // A throttled refresh is the master's guard working as designed, not a fault — so the panel
        // says how long and STAYS OPEN on the numbers it already had. Closing would read as a crash,
        // and clearing the view would punish the operator for asking.
        else ui.notify(usageFailureMessage(refreshed.failure), refreshed.failure.kind === "throttled" ? "info" : "error")
        continue
      }

      const account = accountByRow.get(chosen)
      // Unreachable by construction: every non-refresh row is a key of that map. Treated as a cancel
      // rather than asserted, because the alternative is throwing inside a dialog handler over a
      // string the operator cannot have typed.
      if (account === undefined) return

      const { options, actionByOption } = formatSwitchActions({ account, slots: deps.slots })
      const picked = await ui.select(`${account.idPrefix} ${account.label}`, options)
      if (picked === undefined) return
      const action = actionByOption.get(picked)
      if (action === undefined) return
      // Back to the LIST, not out of the panel: a mis-tap on a row is the ordinary case, and being
      // dropped out for it means reopening and re-reading the whole roster.
      if (action === "back") continue

      // switchTo owns its own reporting — success wording, refusal wording and the local refusals all
      // live with the lease, not here, so this path cannot invent a second vocabulary for them.
      await deps.switchTo({ slotName: action.slotName, prefix: account.idPrefix, label: account.label, pin: action.pin })
      return
    }
  }

  return { open }
}
