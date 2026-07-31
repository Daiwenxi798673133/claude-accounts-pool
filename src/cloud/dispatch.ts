// The mode fork, lifted out of tui.tsx so the decision is a value a test can drive. tui.tsx is a
// Solid component module whose import graph boots the entire TUI; keeping the fork here means the
// three-way choice is provable without any of that, and keeps tui.tsx's own change to two lines.

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { log } from "../logger.ts"
import type { ModeConfig } from "../mode.ts"
import { installCloudMaster } from "../master/install.ts"
import { installCloudWorker } from "../worker/install.ts"

// `local` is an instruction to the CALLER — run your own bootstrap — not a claim that nothing
// happened. `handled` means this function already decided everything and the caller must return.
export type ModeBootstrap = "local" | "handled"

export function dispatchMode(api: TuiPluginApi, config: ModeConfig): ModeBootstrap {
  // A switch over the tagged union with a declared return type, never an if/else chain: a variant
  // added to ModeConfig becomes a compile error here (TS2366) instead of silently falling through
  // to whichever branch happens to be last — and "silently reaching the local bootstrap" is the one
  // fallthrough this plugin cannot afford (see the invalid case).
  switch (config.mode) {
    case "local":
      return "local"
    case "cloud-master": {
      const master = installCloudMaster(api, config)
      api.lifecycle.onDispose(master.dispose)
      return "handled"
    }
    case "cloud-worker": {
      const worker = installCloudWorker(api, config)
      api.lifecycle.onDispose(worker.dispose)
      return "handled"
    }
    case "invalid":
      // INSTALL NOTHING, and above all do not fall back to local. A half-configured cloud install is
      // strictly worse than a refusal: a worker whose config was rejected would run the local
      // bootstrap, which refreshes anthropic chains the master owns — making this box a second
      // refresher of a one-time-use token and stranding the account for good. Stopping costs the
      // user one restart; guessing costs them an account.
      log.error("cloud:mode-invalid", { reason: config.reason })
      api.ui.toast({
        variant: "error",
        // The parser's reason verbatim: it already names the exact offending field, and the user's
        // only useful move is to fix that field in tui.json.
        message: `云模式配置无效,插件未启动任何功能:${config.reason}。请修正 tui.json 后重启 OpenCode`,
      })
      return "handled"
  }
}
