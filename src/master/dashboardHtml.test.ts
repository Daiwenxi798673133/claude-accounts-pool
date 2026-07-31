import { expect, test } from "bun:test"
import { dashboardHtml } from "./dashboardHtml.ts"

// Config values are irrelevant to every assertion below — only the DOCUMENT'S SHAPE is under test
// — but a full DashboardConfig is required to call this pure function once, up front.
const html = dashboardHtml({
  usageRoute: "/v1/usage",
  refreshRoute: "/v1/usage/refresh",
  throttleMs: 30000,
  authorizeRoute: "/v1/accounts/authorize",
  addRoute: "/v1/accounts/add",
})

test("dashboard renders no account id prefix", () => {
  // idPrefix must stay in the /v1/usage payload for the worker's manual-switch UI (see
  // usageView.test.ts) — this asserts on the DOCUMENT dashboardHtml renders instead, never on that
  // payload: the 8-hex chip was the ONLY place the document itself mentioned idPrefix.
  expect(html).not.toContain("idPrefix")
})

test("the expiry line names the access token, in both branches", () => {
  // Both string literals the inline script concatenates, asserted WITH their surrounding quotes so
  // a partial rename (only one branch renamed) cannot pass.
  expect(html).toContain("\"access token \"")
  expect(html).toContain("\"access token 到期时间未知\"")
  // The old wording must be fully gone, not merely supplemented by the new one.
  expect(html).not.toContain("\"token \"")
  expect(html).not.toContain("\"token 到期时间未知\"")
})

test("account cards are laid out in a multi-column grid", () => {
  // #rows was a single flex column — one full-width card per row. The redesign packs cards into an
  // auto-filling grid instead, so both the new track and the old flex declaration are asserted.
  expect(html).toContain("repeat(auto-fill, minmax(320px, 1fr))")
  expect(html).not.toContain("#rows { display: flex; flex-direction: column; gap: 20px; }")
})

test("the document carries no template-literal residue", () => {
  // The whole document lives inside a TS template literal, so a stray backtick or ${ would be a
  // build-breaking edit with no compiler watching it. A standing invariant, not a feature under test.
  expect(html.includes("\u0060")).toBe(false)
  expect(html).not.toContain("${")
})

test("orphans of the card redesign are gone and the footer claim is precise", () => {
  // Once a card shows "access token …" in plain text, "本页不展示任何 token" alone stops being
  // true — it needs "明文" to keep meaning what it always meant.
  expect(html).toContain("本页不展示任何 token 明文。")
  // .id was the removed id-chip's only rule; the 1fr-48px track was the mobile fallback for a
  // 4-column .win row that the narrower card grid no longer needs.
  expect(html).not.toContain(".id {")
  expect(html).not.toContain("grid-template-columns: 1fr 48px")
})
