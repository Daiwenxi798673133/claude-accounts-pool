// 钩子、状态栏命令拿不到终端宽度:Claude Code 以无控制终端的方式跑它们,process.stdout.columns 是空的。
// 但祖先里的 claude 进程挂在一个真终端上 —— 沿父进程链找到第一个有 tty 的,问那个 tty 的尺寸。
//
// 实测(macOS,claude 2.1.281):钩子 → sh → claude(ttys009),`stty -f /dev/ttys009 size` → "49 166"。
// 读的是那一刻的尺寸,所以窗口拉宽拉窄之后下一次 /pool 就跟着变。
//
// 找不到就返回 undefined,调用方退回单列 —— 宽度猜大了会让双列整段折行,猜小了只是多占几行。
export type Exec = (cmd: string[]) => string | undefined

// 父进程链最多走这么多层:钩子 → sh → (sh) → claude,再往上已经是启动 claude 的那个 shell,
// 它挂在同一个终端上,答案不变。
const MAX_DEPTH = 8

/** `ps -o ppid=,tty=` 的一行 → 父 pid 与 tty 名。 */
export function parsePsLine(text: string): { ppid: number; tty: string } | undefined {
  const match = text.trim().match(/^(\d+)\s+(\S+)$/)
  if (!match) return undefined
  return { ppid: Number(match[1]), tty: match[2] }
}

/** `stty size` 的输出("行 列")→ 列数。 */
export function parseSttySize(text: string): number | undefined {
  const match = text.trim().match(/^(\d+)\s+(\d+)$/)
  if (!match) return undefined
  const columns = Number(match[2])
  return columns > 0 ? columns : undefined
}

// macOS 的 ps 对无终端进程印 `??`,Linux 印 `?`。
const NO_TTY = new Set(["?", "??", "-"])

export function detectTerminalWidth(deps: { pid: number; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; exec: Exec }): number | undefined {
  let pid = deps.pid
  for (let depth = 0; depth < MAX_DEPTH && pid > 1; depth += 1) {
    const info = parsePsLine(deps.exec(["ps", "-o", "ppid=,tty=", "-p", String(pid)]) ?? "")
    if (info === undefined) break
    if (!NO_TTY.has(info.tty)) {
      const device = info.tty.startsWith("/dev/") ? info.tty : `/dev/${info.tty}`
      const columns = parseSttySize(deps.exec(["stty", deps.platform === "darwin" ? "-f" : "-F", device, "size"]) ?? "")
      if (columns !== undefined) return columns
      break
    }
    pid = info.ppid
  }
  // 退路:启动 claude 的 shell 导出的 COLUMNS。可能是启动那一刻的宽度,所以排在 tty 之后。
  const fromEnv = Number(deps.env.COLUMNS)
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : undefined
}
