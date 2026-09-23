import { expect, test } from "bun:test"
import { acquireSlot, slotName, slotWorkerId, type SlotDeps, type SlotRelease } from "./slots.ts"

// 假锁:一个"已被占用的槽位名"集合 + 一份调用记录。确定性,不碰文件系统 —— 真原子性由
// scripts/e2e-claude-pool-slots.ts 用真进程抢真锁来证明,这里只证明【决策】对不对。
function fakeLock(occupied: string[] = []) {
  const calls: string[] = []
  const released: string[] = []
  const held = new Set(occupied)
  const acquire = async (target: string): Promise<SlotRelease | undefined> => {
    calls.push(target)
    if (held.has(target)) return undefined
    held.add(target)
    return async () => {
      released.push(target)
      held.delete(target)
    }
  }
  return { acquire, calls, released, held }
}

const deps = (over: Partial<SlotDeps> & { lock?: ReturnType<typeof fakeLock> } = {}): SlotDeps => ({
  baseWorkerId: "vince-cc",
  slots: 4,
  acquire: over.lock?.acquire ?? fakeLock().acquire,
  lockTargetFor: (name) => `/box/${name}.lock`,
  ...over,
})

test("空机器:拿到 1 号槽,workerId 带上槽位号", async () => {
  const handle = await acquireSlot(deps())
  expect(handle?.slotName).toBe("cc-1")
  // master 的账本按 workerId 键,一个会话一个标签,持有者计数才对得上。
  expect(handle?.workerId).toBe("vince-cc.1")
})

test("1 号被占:顺延到 2 号,不等待", async () => {
  const lock = fakeLock(["/box/cc-1.lock"])
  const handle = await acquireSlot(deps({ lock }))
  expect(handle?.workerId).toBe("vince-cc.2")
  expect(lock.calls).toEqual(["/box/cc-1.lock", "/box/cc-2.lock"])
})

test("依次试,拿到就停 —— 不会把剩下的槽位也敲一遍", async () => {
  const lock = fakeLock()
  await acquireSlot(deps({ lock, slots: 8 }))
  expect(lock.calls).toEqual(["/box/cc-1.lock"])
})

// 不占槽位就跑 = 这个会话对别的会话不可见、master 也不把它记成独立持有者,正是本模块要防的双占。
test("全满:拒绝,而不是不占槽位就跑", async () => {
  const lock = fakeLock(["/box/cc-1.lock", "/box/cc-2.lock"])
  expect(await acquireSlot(deps({ lock, slots: 2 }))).toBeUndefined()
  expect(lock.calls).toHaveLength(2)
})

test("slots=0:直接拒绝,一次锁都不试", async () => {
  const lock = fakeLock()
  expect(await acquireSlot(deps({ lock, slots: 0 }))).toBeUndefined()
  expect(lock.calls).toEqual([])
})

test("单个槽位的锁坏掉时跳过它,不让整次启动失败", async () => {
  const calls: string[] = []
  const acquire = async (target: string): Promise<SlotRelease | undefined> => {
    calls.push(target)
    if (target.endsWith("cc-1.lock")) throw new Error("EACCES")
    return async () => {}
  }
  const handle = await acquireSlot(deps({ acquire }))
  expect(handle?.workerId).toBe("vince-cc.2")
  expect(calls).toHaveLength(2)
})

test("release 释放的是拿到的那一个", async () => {
  const lock = fakeLock(["/box/cc-1.lock"])
  const handle = await acquireSlot(deps({ lock }))
  await handle?.release()
  expect(lock.released).toEqual(["/box/cc-2.lock"])
  // 释放之后这个槽位可以被下一个会话拿走
  const next = await acquireSlot(deps({ lock }))
  expect(next?.workerId).toBe("vince-cc.2")
})

test("槽位名与 workerId 的拼法", () => {
  expect(slotName(3)).toBe("cc-3")
  expect(slotWorkerId("vince-cc", 3)).toBe("vince-cc.3")
  // WORKER_LABEL_PATTERN 是 /^[A-Za-z0-9._-]{1,64}$/ —— 拼出来的必须仍然合法,否则 master 400。
  expect(slotWorkerId("vince-cc", 16)).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
})

test("N 个并发调用者各拿到不同的槽位,没有两个撞在一起", async () => {
  const lock = fakeLock()
  const handles = await Promise.all(Array.from({ length: 4 }, () => acquireSlot(deps({ lock, slots: 4 }))))
  const ids = handles.map((h) => h?.workerId)
  expect(new Set(ids).size).toBe(4)
  expect(ids.every((id) => id !== undefined)).toBe(true)
})

test("并发数超过槽位数:多出来的那些拿不到,而不是挤进已占的槽位", async () => {
  const lock = fakeLock()
  const handles = await Promise.all(Array.from({ length: 6 }, () => acquireSlot(deps({ lock, slots: 3 }))))
  const got = handles.filter((h) => h !== undefined)
  expect(got).toHaveLength(3)
  expect(new Set(got.map((h) => h!.workerId)).size).toBe(3)
})
