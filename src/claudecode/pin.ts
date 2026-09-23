// 钉住一个账号:以后每次启动都点名它,直到它的额度用满或操作者取消。
//
// 与 opencode 那条链的 `p` 键、senpi 的 slotPin 是同一个功能,存储形状也照抄 slotPin 踩出来的
// 两条结论:
//   · 自己一个文件,不塞进声明簿。声明簿每次租约都整体重写,pin 挤进去就会被「一次租约、一次按键」
//     两个不相干的触发源读改写,必有一方丢失。
//   · 活过设置它的进程是特性不是 bug —— 这正是「以后每次启动都用它」的字面意思。
//
// 与 senpi 的 pin 不共用文件,理由同声明簿:两条链的租约语义不同,各管各的。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { leaseCacheDir } from "../senpi/leaseCache.ts"
import { log } from "../logger.ts"
import type { Claim } from "./claims.ts"

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

export type Preference = {
  // 发给 master 的点名。undefined = 这次不点名,由排名派号。
  prefix?: string
  // 只在点名时才有意义;与协议里「pinned 必须伴随 preferredAccountIdPrefix」一致。
  pinned?: boolean
  // 给操作者的一句话,仅在"想点名但这次点不成"时出现。
  notice?: string
}

export type PreferenceInput = {
  // 本次命令行上的 --pool-account
  cliPrefix?: string
  // 本次命令行上的 --pool-pin / --pool-unpin
  cliPin?: boolean
  // 之前钉住的那个
  storedPin?: string
  // 本机其它会话已经占着的账号(全 id)
  heldAccountIds: readonly string[]
}

/**
 * 决定这次租约要不要点名、点谁。
 *
 * 【本机已被别的会话占着的号,这次不点名】—— 这是并发下唯一的真正分歧点。点名与排除集会互相矛盾:
 * 我们已经把它放进 excludeAccountIds 了(它确实被本机占着),再点名它等于同时告诉 master
 * 「别给我这个」和「就要这个」。与其赌 master 怎么化解,不如本机自己解决:这次退回排名派号,
 * 并明说为什么 —— 钉住不会因此丢失,下一次那个会话结束后照样点名它。
 */
export function resolvePreference(input: PreferenceInput): Preference {
  const wanted = input.cliPrefix ?? (input.cliPin === false ? undefined : input.storedPin)
  if (wanted === undefined) return {}

  const takenBy = input.heldAccountIds.find((id) => id.startsWith(wanted))
  if (takenBy !== undefined) {
    return {
      notice:
        `账号 ${wanted} 正被本机另一个会话占着,这次改由账号池排名派号。` +
        (input.cliPrefix !== undefined ? "" : "钉住没有取消,那个会话结束后会继续点名它。"),
    }
  }

  // pinned 只有在【本次要建立或维持钉住】时才是 true。一次性的 --pool-account 是 pinned:false,
  // 那正是协议里「一次性 enter 切号」与「p 钉住」的区别。
  const pinned = input.cliPin === true || (input.cliPin === undefined && input.storedPin === wanted)
  return { prefix: wanted, pinned }
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

export const heldIdsOf = (claims: readonly Claim[]): string[] => claims.map((claim) => claim.accountId)
