export type PartLike = { type: string; tool?: string; text?: string; state?: { status?: string } }

// We never revert after a rate-limit switch, so resuming is the only question: a turn that already
// produced output (ran a tool, wrote a patch, reasoned, or emitted real text) is continued so the new
// account picks up the half-done work; one with no output yet is safe to resend as the original prompt.
// Whitespace-only/synthetic text is not output.
export function decideRedo(parts: readonly PartLike[]): "continue" | "resend" {
  for (const part of parts) {
    if (part.type === "tool" || part.type === "patch" || part.type === "reasoning") return "continue"
    if (part.type === "text" && (part.text ?? "").trim().length > 0) return "continue"
  }
  return "resend"
}
