// 一台机器上并发的 N 个 claude-pool 会话,怎么互不相撞。
//
// 这条链与 senpi 那条的结构差别决定了这里的形状:senpi 是【一个进程】开 K 个槽位、每个槽位一个续期
// 循环;这里是【K 个互不相识的进程】,每个进程一个会话、一枚冻结的凭证。所以没有"进程内串行化"
// 这一层可做(slotRoster 的位置),全部协调必须是机器级的。
//
// 槽位 = 一个 workerId。这是与 senpi 最重要的分歧,也是故意的:master 的租约账本是【按 workerId 键
// 的 Map】(src/master/scheduler.ts:691),一台机器一个条目。senpi 的 K 个槽位全在一个 workerId 下,
// 于是 master 只记得住最后一条 —— 它对 senpi 的持有者计数按构造就是错的(slotLock.ts 的注释承认了
// 这点)。这条链一个会话一个标签,master 的账本因此天然是对的:
//   · fewestHolders 能看见这台机器真正占了几个号
//   · MAX_ACCOUNT_HOLDERS 的封顶算得对
//   · 同机器上 senpi 那条链下次租号时会绕开我们占着的号 —— 跨链协调交给 master,本机不共享任何文件
//
// 锁的持有期是【整个会话】,不是一次临界区。proper-lockfile 在持有期间每 update ms 刷新 mtime,所以
// 一个开了四小时的会话不会被偷走;进程被 SIGKILL 则 stale 之后可被回收。这正是我们要的语义,所以
// 这里复用 senpi 的原语而不是另造 —— 但参数不同,见下。
import { log } from "../logger.ts"

export type SlotRelease = () => Promise<void>

// 注入,不默认:真锁在组合根里接 proper-lockfile,测试里换成确定性的假锁。
// 返回 undefined = 这个槽位被别人占着(或锁不可用),调用方应当去试下一个 —— 绝不等待。
export type SlotAcquire = (lockTarget: string) => Promise<SlotRelease | undefined>

export type SlotDeps = {
  baseWorkerId: string
  slots: number
  acquire: SlotAcquire
  // 锁目标的路径由调用方给,因为"文件放哪"是组合根的事。
  lockTargetFor: (slotName: string) => string
}

export type SlotHandle = {
  slotName: string
  // 发给 master 的身份。一个会话一个,所以 master 的账本里一个会话就是一个持有者。
  workerId: string
  release: SlotRelease
}

/** `vince-cc` + 槽位 2 → `vince-cc.2`。WORKER_LABEL_PATTERN 允许 `.`,所以协议零改动。 */
export function slotWorkerId(baseWorkerId: string, index: number): string {
  return `${baseWorkerId}.${index}`
}

export function slotName(index: number): string {
  return `cc-${index}`
}

/**
 * 从 1 开始依次试,拿到的第一个空槽位就是我们的。全满则 undefined。
 *
 * 【依次试而不是随机挑】:并发启动时随机挑会让两个进程更可能撞在一起再各自重试,依次试则天然错开 ——
 * 先到的占 1 号,后到的在 1 号上被拒、立刻去试 2 号。每次被拒的成本是一次 O(锁重试) 的失败,而
 * withSlotLock 的重试预算本来就极小(两次、50–200ms)。
 *
 * 【全满时拒绝启动,而不是不占槽位就跑】:不占槽位意味着这个会话对别的会话不可见,master 也不会
 * 把它记成独立持有者 —— 那正是本模块要防的双占。宁可让操作者知道"这台机器的并发位满了"。
 */
export async function acquireSlot(deps: SlotDeps): Promise<SlotHandle | undefined> {
  for (let index = 1; index <= deps.slots; index++) {
    const name = slotName(index)
    // 单个槽位的锁坏掉(目录不可写、锁文件被别的东西占住)不该让整次启动失败:1 号坏了就去试 2 号。
    // 与"被别人占着"归为同一种结果,是因为对调用方而言它们要做的事完全一样。
    let release: SlotRelease | undefined
    try {
      release = await deps.acquire(deps.lockTargetFor(name))
    } catch (error) {
      log.warn("claudecode:slot-lock-error", { slotName: name, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (release === undefined) continue
    const handle = { slotName: name, workerId: slotWorkerId(deps.baseWorkerId, index), release }
    log.info("claudecode:slot-acquired", { slotName: name, workerId: handle.workerId })
    return handle
  }
  log.warn("claudecode:slots-exhausted", { slots: deps.slots })
  return undefined
}
