import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { accountsOf, activeIdOf, loadAccounts, providerOf, removeAccount, setAccountExcluded } from "./src/accounts.ts"
import { autoCapture, collectAllUsage, retryFlaggedRefresh, switchToAccount } from "./src/usage.ts"
import { fetchOpenaiUsage } from "./src/openai-usage.ts"
import { backfillOpenaiLabel, captureOpenaiSlot, switchToOpenaiAccount } from "./src/openai-slot.ts"
import { backfillClaudePlans } from "./src/plan-backfill.ts"
import { installAutoSwitch } from "./src/autoswitch.ts"
import { installTokenKeeper } from "./src/keeper.ts"
import { logBundleCommand } from "./src/logbundle.ts"
import { initLogger, log } from "./src/logger.ts"
import { openUsageDialog, type UsageState } from "./src/dialogs.tsx"
import { aggregate, loadRows, type RawRow, type TimeRange } from "./src/stats.ts"
import { openStatsDialog, type StatsState } from "./src/stats-dialog.tsx"
import { parseMode } from "./src/mode.ts"
import { dispatchMode } from "./src/cloud/dispatch.ts"

const ID = "claude-accounts-usage"

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const tui: TuiPlugin = async (api, options) => {
  initLogger(api.client)
  // THE MODE FORK, and it must stay the first statement after the logger: everything below it is
  // the LOCAL bootstrap, which refreshes anthropic chains and captures auth.json's tip — on a cloud
  // worker that is a SECOND refresher of a one-time-use token, i.e. the permanent-strand failure.
  // So a cloud mode returns here instead of reaching any of it, and an invalid config installs
  // nothing at all rather than running half-configured. Absent options parse as `local`, so every
  // existing install falls straight through to the exact sequence it has always run.
  if (dispatchMode(api, parseMode(options)) === "handled") return
  const [state, setState] = createSignal<UsageState>({ loading: false, openaiLoading: false, results: [] })
  const [statsState, setStatsState] = createSignal<StatsState>({ loading: false })

  const autoSwitch = installAutoSwitch(api)
  api.lifecycle.onDispose(autoSwitch.dispose)

  const keeper = installTokenKeeper(autoSwitch.isSessionRunning)
  api.lifecycle.onDispose(keeper.dispose)

  let statsRows: RawRow[] | undefined
  let statsSeq = 0
  const reloadStats = async (range: TimeRange) => {
    if (statsRows) {
      try {
        setStatsState({ loading: false, data: aggregate(statsRows, range) })
      } catch (error) {
        log.warn("tui:stats-aggregate-fail", { error: message(error) })
        setStatsState({ loading: false, error: message(error) })
      }
      return
    }
    const seq = ++statsSeq
    setStatsState({ loading: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    try {
      const rows = loadRows()
      statsRows = rows
      if (seq === statsSeq) setStatsState({ loading: false, data: aggregate(rows, range) })
    } catch (error) {
      log.warn("tui:stats-load-fail", { error: message(error) })
      if (seq === statsSeq) setStatsState({ loading: false, error: message(error) })
    }
  }

  const refreshUsage = async () => {
    // Kicked off first and awaited last so the ChatGPT call overlaps the Claude collect
    // instead of delaying the panel; its failures stay inside its own result object.
    setState((prev) => ({ ...prev, openaiLoading: true }))
    const openaiPending = fetchOpenaiUsage().catch((error) => {
      log.warn("tui:openai-usage-fail", { error: message(error) })
      return undefined
    })
    try {
      await autoCapture()
      const { results } = await collectAllUsage({
        isSessionRunning: autoSwitch.isSessionRunning,
        onPartial: (results) => setState((prev) => ({ ...prev, loading: true, results, updatedAt: Date.now(), error: undefined })),
      })
      autoSwitch.setUsageCache(results)
      setState((prev) => ({ ...prev, loading: false, results, updatedAt: Date.now(), error: undefined }))
    } catch (error) {
      log.warn("tui:refresh-usage-fail", { error: message(error) })
      setState((prev) => ({ ...prev, loading: false, results: prev.results, updatedAt: undefined, error: message(error) }))
    }
    const openai = await openaiPending
    setState((prev) => ({ ...prev, openai, openaiLoading: false }))
    // AFTER the panel already has the data, and it issues no request of its own — it only joins
    // the email this response carried onto the record that response authenticated as. Awaiting it
    // cannot delay anything the user sees; the state above is already committed.
    await backfillOpenaiLabel({ accountId: openai?.accountId, email: openai?.email }).catch((error) =>
      log.warn("tui:openai-label-backfill-fail", { error: message(error) }),
    )
    // MUST stay last: unlike the label backfill above it issues requests, and a plan badge is
    // worth nobody's latency. Consequence: a newly-seen account's badge appears on the NEXT open.
    await backfillClaudePlans().catch((error) => log.debug("tui:plan-backfill-fail", { error: message(error) }))
  }

  void autoCapture().catch((e) => log.debug("tui:autocapture-fail", { error: message(e) }))

  const command = api.command
  if (!command) {
    log.error("tui:no-command-api")
    api.ui.toast({ variant: "error", message: "当前 OpenCode 不支持命令注册 API,请更新 OpenCode" })
    return
  }

  command.register(() => [
    {
      title: "Claude: 查看账号用量并切换",
      value: `${ID}.usage`,
      category: "Claude",
      slash: { name: "usage" },
      onSelect: async () => {
        await autoCapture().catch((e) => log.debug("tui:autocapture-fail", { error: message(e) }))
        // The openai twin of autoCapture, and it makes no network call. The keeper already does
        // this on its tick, but a /usage opened inside that window would otherwise show the slot
        // occupant as an un-attributed read-only block instead of a switchable row.
        await captureOpenaiSlot().catch((e) => log.debug("tui:openai-capture-fail", { error: message(e) }))
        const file = await loadAccounts()
        // INV-P1: these two lists must never be merged, and neither may be filtered by hand. The
        // Claude page's enter calls switchToAccount (the anthropic-slot writer) and the ChatGPT
        // page's calls switchToOpenaiAccount; a record reaching the wrong one would file its
        // refresh token under the other provider's auth.json entry.
        const claudeAccounts = accountsOf(file, "anthropic")
        const openaiAccounts = accountsOf(file, "openai")
        log.info("tui:usage-open", { accounts: claudeAccounts.length, openai: openaiAccounts.length })
        if (claudeAccounts.length === 0 && openaiAccounts.length === 0) {
          api.ui.toast({
            variant: "warning",
            message: "没有账号。请先用 ex-machina 登录 Claude,或用 opencode auth login 登录 ChatGPT",
          })
          return
        }
        setState((prev) => ({ ...prev, loading: true, openaiLoading: true, error: undefined }))
        openUsageDialog(api, {
          accounts: claudeAccounts,
          activeId: file.activeId,
          openaiAccounts,
          openaiActiveId: activeIdOf(file, "openai"),
          state,
          onSwitch: async (id) => {
            try {
              const current = await loadAccounts()
              const target = current.accounts.find((account) => account.id === id)
              if (target?.needsReauth) {
                try {
                  await retryFlaggedRefresh(id)
                  log.info("tui:retry-reauth-ok", { id })
                } catch (error) {
                  log.warn("tui:retry-reauth-fail", { id, error: message(error) })
                  api.ui.toast({ variant: "error", message: `该账号需重新登录,请用 ex-machina 重新登录后再切换` })
                  return
                }
              }
              const account = await switchToAccount(id, "anthropic")
              log.info("tui:switch-ok", { id })
              api.ui.toast({ variant: "success", message: `已切换到 ${account.label},下次对话生效` })
            } catch (error) {
              log.warn("tui:switch-fail", { id, error: message(error) })
              api.ui.toast({ variant: "error", message: `切换失败: ${message(error)}` })
            }
          },
          onOpenaiSwitch: async (id) => {
            try {
              const account = await switchToOpenaiAccount(id)
              log.info("tui:openai-switch-ok", { id })
              api.ui.toast({ variant: "success", message: `已切换到 ${account.label},下次对话生效` })
              // The cached usage describes the account that just LEFT the slot, so it must not
              // survive into a panel where a different row is now marked In Use.
              setState((prev) => ({ ...prev, openai: undefined }))
              void refreshUsage()
            } catch (error) {
              log.warn("tui:openai-switch-fail", { id, error: message(error) })
              // Prefixed like the Claude path, but the specific refusal is kept verbatim rather
              // than collapsed into a bare "切换失败" — switchToOpenaiAccount's messages already
              // tell the user what to do ("该账号缺少 accountId,请重新登录 ChatGPT" and friends).
              api.ui.toast({ variant: "error", message: `切换失败: ${message(error)}` })
            }
          },
          // removeAccount / setAccountExcluded are already provider-agnostic (they key on id and
          // clear every provider's active pointer), so both pages share these two.
          onDelete: async (id) => {
            try {
              const removed = await removeAccount(id)
              log.info("tui:remove-ok", { id })
              if (removed) api.ui.toast({ variant: "success", message: `已删除账号 ${removed.label}` })
              void refreshUsage()
            } catch (error) {
              log.warn("tui:remove-fail", { id, error: message(error) })
              api.ui.toast({ variant: "error", message: `删除失败: ${message(error)}` })
            }
          },
          onToggleExclude: async (id, next) => {
            try {
              const account = await setAccountExcluded(id, next)
              // The Claude wording would let a ChatGPT user infer an auto-switch that is still
              // dark for their provider. The flag is persisted either way and becomes live when
              // OPENAI_AUTOSWITCH_ENABLED flips; the toast just must not overstate today.
              const marked =
                account && providerOf(account) === "openai" ? "已标记(ChatGPT 自动切号尚未启用)" : "已标记,不参与自动切号"
              api.ui.toast({ variant: "success", message: next ? marked : "已取消标记" })
            } catch (error) {
              api.ui.toast({ variant: "error", message: `标记失败: ${message(error)}` })
            }
          },
        })
        void refreshUsage()
      },
    },
    {
      title: "Claude: 查看 OpenCode 用量统计",
      value: `${ID}.stats`,
      category: "Claude",
      slash: { name: "stats" },
      onSelect: async () => {
        log.info("tui:stats-open")
        statsRows = undefined
        setStatsState({ loading: true })
        openStatsDialog(api, statsState, (range) => void reloadStats(range))
        await reloadStats("all")
      },
    },
    logBundleCommand(api, "local"),
  ])
}

const plugin: TuiPluginModule & { id: string } = { id: ID, tui }

export default plugin
