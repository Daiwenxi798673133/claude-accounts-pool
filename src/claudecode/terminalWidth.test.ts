import { expect, test } from "bun:test"
import { detectTerminalWidth, parsePsLine, parseSttySize, type Exec } from "./terminalWidth.ts"

test("解析 ps 与 stty 的输出", () => {
  expect(parsePsLine("  83035 ttys009\n")).toEqual({ ppid: 83035, tty: "ttys009" })
  expect(parsePsLine("1 ??")).toEqual({ ppid: 1, tty: "??" })
  expect(parsePsLine("")).toBeUndefined()
  expect(parseSttySize("49 166\n")).toBe(166)
  expect(parseSttySize("0 0")).toBeUndefined()
  expect(parseSttySize("stty: /dev/x: Permission denied")).toBeUndefined()
})

// 钩子 → sh(无 tty)→ claude(ttys009):实测的形状。
function tree(ttys: Record<number, [number, string]>, size: Record<string, string>): { exec: Exec; calls: string[][] } {
  const calls: string[][] = []
  const exec: Exec = (cmd) => {
    calls.push(cmd)
    if (cmd[0] === "ps") {
      const row = ttys[Number(cmd.at(-1))]
      return row === undefined ? undefined : `${row[0]} ${row[1]}\n`
    }
    return size[cmd[2]]
  }
  return { exec, calls }
}

test("沿父进程链找到第一个挂在终端上的祖先,问它那个 tty 的列数", () => {
  const { exec, calls } = tree({ 300: [200, "??"], 200: [100, "ttys009"] }, { "/dev/ttys009": "49 166" })
  expect(detectTerminalWidth({ pid: 300, platform: "darwin", env: {}, exec })).toBe(166)
  expect(calls.at(-1)).toEqual(["stty", "-f", "/dev/ttys009", "size"])
})

test("Linux 用 stty -F,tty 名形如 pts/3", () => {
  const { exec, calls } = tree({ 300: [200, "pts/3"] }, { "/dev/pts/3": "40 120" })
  expect(detectTerminalWidth({ pid: 300, platform: "linux", env: {}, exec })).toBe(120)
  expect(calls.at(-1)).toEqual(["stty", "-F", "/dev/pts/3", "size"])
})

test("找不到终端就退回 COLUMNS;COLUMNS 也没有(或是 0)就 undefined", () => {
  const { exec } = tree({ 300: [1, "??"] }, {})
  expect(detectTerminalWidth({ pid: 300, platform: "darwin", env: { COLUMNS: "132" }, exec })).toBe(132)
  expect(detectTerminalWidth({ pid: 300, platform: "darwin", env: { COLUMNS: "0" }, exec })).toBeUndefined()
  expect(detectTerminalWidth({ pid: 300, platform: "darwin", env: {}, exec: () => undefined })).toBeUndefined()
})

test("父进程链有上限,不会在一个成环的假 ps 上转圈", () => {
  const { exec, calls } = tree({ 300: [300, "??"] }, {})
  expect(detectTerminalWidth({ pid: 300, platform: "darwin", env: {}, exec })).toBeUndefined()
  expect(calls.length).toBeLessThanOrEqual(8)
})
