import { expect, test } from "bun:test"
import { decideRedo, type PartLike } from "./continuation.ts"

const cases: { name: string; parts: PartLike[]; want: "continue" | "resend" }[] = [
  { name: "非空文本 → continue(有产出)", parts: [{ type: "text", text: "已经写了一半" }], want: "continue" },
  { name: "纯空白文本 → resend(无产出)", parts: [{ type: "text", text: "   \n\t " }], want: "resend" },
  { name: "tool part → continue", parts: [{ type: "tool", tool: "edit", state: { status: "completed" } }], want: "continue" },
  { name: "patch part → continue", parts: [{ type: "patch" }], want: "continue" },
  { name: "reasoning part → continue", parts: [{ type: "reasoning" }], want: "continue" },
  { name: "空数组 → resend", parts: [], want: "resend" },
  {
    name: "混合:空文本 + tool → continue",
    parts: [{ type: "text", text: "" }, { type: "tool", tool: "bash", state: { status: "running" } }],
    want: "continue",
  },
]

for (const c of cases) {
  test(`decideRedo:${c.name}`, () => {
    expect(decideRedo(c.parts)).toBe(c.want)
  })
}
