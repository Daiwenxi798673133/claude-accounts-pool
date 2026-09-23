# 一键让这台机器上的 Claude Code 全面走账号池(make setup),以及一键撤回(make revert)。
# 细节见 scripts/cc-takeover.ts 与 issue #93。
#
#   make setup                              # 依次提示 master 的 ip:port 与 WorkerID
#   make setup MASTER=100.64.0.36:8787 WORKER=vince-mbp   # 不提问
#   make status                             # 装没装、relay 在不在、当前共享哪个号
#   make revert                             # 撤回:Claude Code 回到你自己的号

.PHONY: setup revert status

BUN := $(shell command -v bun 2>/dev/null)
# 只认命令行上给的 MASTER / WORKER:make 默认也会从环境变量里取同名值,而 MASTER 这种名字很可能
# 被别的东西用着 —— 那样 setup 会一声不响地拿它去配池子。
MASTER_ARG := $(if $(filter command line,$(origin MASTER)),$(MASTER))
WORKER_ARG := $(if $(filter command line,$(origin WORKER)),$(WORKER))

setup:
	@if [ -z "$(BUN)" ]; then echo "需要 bun:curl -fsSL https://bun.sh/install | bash" >&2; exit 1; fi
	@if [ ! -d node_modules ]; then "$(BUN)" install >/dev/null || exit 1; fi
	@"$(BUN)" scripts/cc-takeover.ts setup --master "$(MASTER_ARG)" --worker "$(WORKER_ARG)"

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
