// 钉住一个账号:这台机器的共享号一直点名它,直到它的额度用满或操作者取消。
//
// 【机器级,不是会话级】本机所有会话共用 relay 手里的那一个号(issue #83 定稿),所以钉住描述的是
// "这台机器用哪个号":启动器落盘意图,relay 在每一次自动租约(续期、换号、重启后首租)时读它。
// 撞额度时 relay 先上报再点名,master 以 cooling 拒绝,钉住随之交还 —— 与 src/worker/pin.ts 同一个
// "额度用满前不被轮换走"。
//
// 与 opencode 那条链的 `p` 键、senpi 的 slotPin 是同一个功能,存储形状也照抄 slotPin 踩出来的
// 两条结论:
//   · 自己一个文件。它有两个互不相干的写者(启动器落盘意图、relay 交还被拒的钉住),各自整体重写,
//     挤进任何别的状态文件都会被另一方的读改写覆盖。
//   · 活过设置它的进程是特性不是 bug —— 这正是「以后每次启动都用它」的字面意思。
//
// 与 senpi 的 pin 不共用文件:两条链的租约各管各的。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { leaseCacheDir } from "../senpi/leaseCache.ts"
import { log } from "../logger.ts"

const PIN_VERSION = 1

export function pinPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(leaseCacheDir(env), "cc-pin.json")
}

export type PinStore = {
  read: () => string | undefined
  write: (accountPrefix: string | undefined) => void
}

export function createPinStore(env: NodeJS.ProcessEnv = process.env): PinStore {
  const path = pinPath(env)
  return {
    // 同步:它在构造租约请求时被读到,异步读会让请求先于答案发出去(与 slotPin 同一条理由)。
    read: () => {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: number; accountPrefix?: unknown }
        if (raw.version !== PIN_VERSION) return undefined
        return typeof raw.accountPrefix === "string" && raw.accountPrefix.length > 0 ? raw.accountPrefix : undefined
      } catch {
        // 文件不存在是常态(没钉过);坏掉则当作没钉 —— 一个读不懂的 pin 不该拦住启动。
        return undefined
      }
    },
    write: (accountPrefix) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const tmp = `${path}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify({ version: PIN_VERSION, accountPrefix: accountPrefix ?? null }, null, 2), {
        mode: 0o600,
      })
      renameSync(tmp, path)
      log.info("claudecode:pin-written", { accountPrefix })
    },
  }
}

/** 把本次命令行对钉住的意图落盘。返回是否写了,只为日志。 */
export function applyPinIntent(store: PinStore, args: { accountPrefix?: string; pin?: boolean }): boolean {
  if (args.pin === true && args.accountPrefix !== undefined) {
    store.write(args.accountPrefix)
    return true
  }
  if (args.pin === false) {
    store.write(undefined)
    return true
  }
  return false
}

