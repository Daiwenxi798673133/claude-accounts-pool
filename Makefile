# 一键让这台机器上的 Claude Code 全面走账号池(make setup),以及一键撤回(make revert)。
# 细节见 scripts/cc-takeover.ts 与 issue #93。
#
#   make setup                              # 依次提示 master 的 ip:port 与 WorkerID
#   make setup MASTER=100.64.0.36:8787 WORKER=vince-mbp   # 不提问
#   make status                             # 装没装、relay 在不在、当前共享哪个号
#   make revert                             # 撤回:Claude Code 回到你自己的号

.PHONY: setup revert status

BUN := $(shell command -v bun 2>/dev/null)

setup:
	@if [ -z "$(BUN)" ]; then echo "需要 bun:curl -fsSL https://bun.sh/install | bash" >&2; exit 1; fi
	@if [ ! -d node_modules ]; then "$(BUN)" install >/dev/null || exit 1; fi
	@"$(BUN)" scripts/cc-takeover.ts setup --master "$(MASTER)" --worker "$(WORKER)"

revert:
	@if [ -z "$(BUN)" ]; then \
		echo "找不到 bun,没法自动撤回。手工撤回:" >&2; \
		echo "  1. 从 ~/.claude/settings.json 的 env 里删掉 CLAUDE_CODE_PROCESS_WRAPPER" >&2; \
		echo "  2. 删掉 shell rc 末尾 claude-accounts-pool 标记之间的那一段" >&2; \
		echo "  3. launchctl bootout gui/$$(id -u)/com.claude-accounts-pool.relay; rm ~/Library/LaunchAgents/com.claude-accounts-pool.relay.plist" >&2; \
		echo "  4. rm ~/.claude-accounts-pool/cc-takeover.json" >&2; \
		exit 1; \
	fi
	@"$(BUN)" scripts/cc-takeover.ts revert

status:
	@"$(BUN)" scripts/cc-takeover.ts status
