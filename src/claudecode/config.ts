// 这条链自己的配置:连哪个 master(与 senpi 共用)、以什么基名租号(自己的)、本机允许几个并发会话。
//
// 【为什么 workerId 要自己一个,而不是沿用 senpi 那个】master 的租约账本按 workerId 键。两条链共用
// 一个标签,master 就只记得住最后租的那一条,于是它对这台机器的持有者计数是错的 —— 同一个号会被
// 同时派给两条链,一个 5 小时窗口被双倍烧。给这条链一个自己的基名,master 就分别记账,
// fewestHolders 会让两条链自动互相绕开。跨链协调交给 master,本机不共享任何文件。
//
// 【为什么缓存/pin 文件不与 senpi 共用】语义不同:senpi 的租约会被它的 keeper adopt 并续期,
// 这条链的租约是冻结的。共用一份,senpi 就会去续期一条我们管不了的租约 —— 续出来的新 token 进了
// 缓存,而我们的子进程 env 里还是旧那枚。文件名分开,是为了让这件事不可能发生。
import { join } from "node:path"
import { leaseCacheDir } from "../senpi/leaseCache.ts"
import { readWorkerConfig } from "../senpi/workerConfig.ts"

// senpi 那条链的上限是 16(它的宿主只读得到 16 个编号变量)。这条链没有那个约束 —— 每个会话一个
// 进程 —— 但并发会话数仍然该有个上限:每个会话都占着一个池子账号,而 MAX_ACCOUNT_HOLDERS 是 3,
// 一台机器把池子占空对谁都没好处。
export const CC_MAX_SLOTS = 8
export const CC_DEFAULT_SLOTS = 2

export type ClaudeCodePoolConfig = { masterUrl: string; baseWorkerId: string; slots: number }

export function parseSlots(raw: string | number | undefined): number {
  if (raw === undefined) return CC_DEFAULT_SLOTS
  const parsed = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return CC_DEFAULT_SLOTS
  return Math.min(parsed, CC_MAX_SLOTS)
}

/**
 * 基名的来源,按优先级:环境变量 → 配置文件里的 `ccWorkerId` → 由 senpi 的标签推导。
 *
 * 推导出的默认值(`<senpi 标签>.cc`)保证了「没配过也能跑,且不会与 senpi 撞标签」;显式配置则让
 * 操作者能起一个短名字(比如 `vince-cc`),那是看板上会被人读到的东西。
 */
export function resolveBaseWorkerId(senpiWorkerId: string, stored: unknown, env: NodeJS.ProcessEnv): string {
  const fromEnv = env.CAP_CC_WORKER
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv
  if (typeof stored === "string" && stored.length > 0) return stored
  return `${senpiWorkerId}.cc`
}

export function readPoolConfig(env: NodeJS.ProcessEnv = process.env): ClaudeCodePoolConfig | undefined {
  const base = readWorkerConfig(env)
  if (!base) return undefined
  // 同一个文件,只是多读两个字段 —— 配置手术仅追加,这里也一样:读不到就用默认,不报错。
  const raw = base as unknown as { ccWorkerId?: unknown; ccSlots?: unknown }
  return {
    masterUrl: base.masterUrl,
    baseWorkerId: resolveBaseWorkerId(base.workerId, raw.ccWorkerId, env),
    slots: parseSlots(
      (env.CAP_CC_SLOTS as string | undefined) ?? (typeof raw.ccSlots === "number" ? raw.ccSlots : undefined),
    ),
  }
}

/** 锁文件与 senpi 的分开:`cc-slot-*.lock`,与 `senpi-slot-*.lock` 各不相干。 */
export function slotLockTarget(slotName: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(leaseCacheDir(env), `${slotName}.lock`)
}
