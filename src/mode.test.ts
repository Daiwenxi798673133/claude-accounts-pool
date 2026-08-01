import { expect, test } from "bun:test"
import { parseMode } from "./mode.ts"

test("undefined options parse as local", () => {
  expect(parseMode(undefined)).toEqual({ mode: "local" })
})

test("missing mode parses as local", () => {
  // A user who configures the plugin with unrelated options is still a local user:
  // absence of `mode` is not a misconfiguration, it is the default deployment.
  expect(parseMode({})).toEqual({ mode: "local" })
  expect(parseMode({ somethingElse: 1 })).toEqual({ mode: "local" })
  expect(parseMode({ mode: "local" })).toEqual({ mode: "local" })
})

test("valid cloud-master config parses", () => {
  expect(parseMode({ mode: "cloud-master", hostname: "0.0.0.0", port: 8787 })).toEqual({
    mode: "cloud-master",
    hostname: "0.0.0.0",
    port: 8787,
  })
  // hostname is optional and defaults to loopback — binding the world by accident is worse
  // than binding too little, since this port hands out live access tokens.
  expect(parseMode({ mode: "cloud-master", port: 8787 })).toEqual({
    mode: "cloud-master",
    hostname: "127.0.0.1",
    port: 8787,
  })

  for (const bad of [undefined, 0, 65536, 1.5, "8787", null]) {
    const got = parseMode({ mode: "cloud-master", port: bad })
    expect(got.mode).toBe("invalid")
    if (got.mode !== "invalid") throw new Error("unreachable")
    expect(got.reason).toContain("port")
  }

  // A hostname that is PRESENT but unusable must not silently collapse to the default —
  // the operator asked to bind somewhere specific and deserves to hear that it failed.
  const badHost = parseMode({ mode: "cloud-master", hostname: 42, port: 8787 })
  expect(badHost.mode).toBe("invalid")
  if (badHost.mode !== "invalid") throw new Error("unreachable")
  expect(badHost.reason).toContain("hostname")
})

test("cloud-worker requires masterUrl workerId", () => {
  expect(
    parseMode({
      mode: "cloud-worker",
      masterUrl: "http://10.0.0.2:8787",
      workerId: "laptop-1",
    }),
  ).toEqual({
    mode: "cloud-worker",
    masterUrl: "http://10.0.0.2:8787",
    workerId: "laptop-1",
  })

  const missingEach: { patch: Record<string, unknown>; field: string }[] = [
    { patch: { masterUrl: undefined }, field: "masterUrl" },
    { patch: { masterUrl: "   " }, field: "masterUrl" },
    { patch: { masterUrl: "ftp://10.0.0.2" }, field: "masterUrl" },
    { patch: { masterUrl: "not a url" }, field: "masterUrl" },
    { patch: { workerId: undefined }, field: "workerId" },
    { patch: { workerId: "  " }, field: "workerId" },
  ]
  for (const { patch, field } of missingEach) {
    const got = parseMode({
      mode: "cloud-worker",
      masterUrl: "https://master.example",
      workerId: "laptop-1",
      ...patch,
    })
    expect(got.mode).toBe("invalid")
    if (got.mode !== "invalid") throw new Error("unreachable")
    expect(got.reason).toContain(field)
  }

  // Both missing at once names both, so one restart fixes the whole config.
  const none = parseMode({ mode: "cloud-worker" })
  expect(none.mode).toBe("invalid")
  if (none.mode !== "invalid") throw new Error("unreachable")
  for (const field of ["masterUrl", "workerId"]) expect(none.reason).toContain(field)
})

test("unknown mode yields invalid with reason", () => {
  const got = parseMode({ mode: "cloud-mister" })
  expect(got.mode).toBe("invalid")
  if (got.mode !== "invalid") throw new Error("unreachable")
  expect(got.reason).toContain("cloud-mister")

  // A non-string `mode` is just as unknown, and the reason still has to be actionable.
  const numeric = parseMode({ mode: 7 })
  expect(numeric.mode).toBe("invalid")
  if (numeric.mode !== "invalid") throw new Error("unreachable")
  expect(numeric.reason).toContain("7")
})
