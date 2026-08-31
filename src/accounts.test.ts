import { afterEach, describe, expect, test } from "bun:test"
import { basename } from "node:path"
import { accountsPath, setAccountsScope } from "./accounts.ts"

// The scope is module-level process state, so every case restores the default it found.
afterEach(() => setAccountsScope("shared"))

describe("accountsPath", () => {
  test("shared 作用域仍是 claude-accounts.json —— master 的池子不许被搬走", () => {
    setAccountsScope("shared")
    expect(basename(accountsPath())).toBe("claude-accounts.json")
  })

  test("cloud-worker 作用域用带后缀的独立文件，与 shared 不同名", () => {
    const shared = accountsPath()
    setAccountsScope("cloud-worker")
    const worker = accountsPath()
    expect(worker).not.toBe(shared)
    expect(basename(worker)).toBe("claude-accounts.cloud-worker.json")
  })

  test("两个作用域落在同一目录，只有文件名不同", () => {
    setAccountsScope("shared")
    const shared = accountsPath()
    setAccountsScope("cloud-worker")
    expect(accountsPath().slice(0, -basename(accountsPath()).length)).toBe(shared.slice(0, -basename(shared).length))
  })
})
