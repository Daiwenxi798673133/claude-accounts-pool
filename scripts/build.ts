import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["./tui.tsx", "./cli.ts"],
  target: "bun",
  outdir: "./dist",
  plugins: [solidPlugin],
  external: [
    "@opentui/solid",
    "@opentui/core",
    "@opencode-ai/plugin",
    "@opencode-ai/plugin/tui",
    "solid-js",
    "solid-js/web",
    "solid-js/store",
  ],
  format: "esm",
})

if (!result.success) {
  console.error("Build failed:")
  for (const msg of result.logs) console.error(msg)
  process.exit(1)
}

// The CLI is a bin entry, so it needs a shebang. Prepended after the build rather than through a
// bundler banner, which would also land on dist/tui.js where a shebang is meaningless.
const cli = Bun.file("./dist/cli.js")
await Bun.write("./dist/cli.js", `#!/usr/bin/env bun\n${await cli.text()}`)

for (const artifact of result.outputs) {
  console.log(`  ${artifact.path} (${(artifact.size / 1024).toFixed(1)} KB)`)
}
console.log("Build succeeded")
