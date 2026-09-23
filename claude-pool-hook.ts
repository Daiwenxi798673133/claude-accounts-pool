#!/usr/bin/env bun
// 限流上报钩子 —— 由 Claude Code 在一轮对话因 API 错误结束时拉起(StopFailure)。
//
// 不是给人敲的:claude-pool.ts 会把它的绝对路径写进交给子进程的 --settings 里。之所以单独一个入口
// 文件而不是给 claude-pool.ts 加子命令,是因为那条命令的契约是「参数一个都不解析,全部透传给 claude」——
// 往里加一个自己的子命令,就等于在那条契约上开一个例外。
//
// 输出被整个丢弃(官方文档:exit code、stdout、stderr 对会话都没有影响),所以这里没有"报错给谁看"
// 这回事 —— 唯一的去处是池子自己的日志。
import { runHook } from "./src/claudecode/hookRun.ts"
import { createHookDeps } from "./src/claudecode/install.ts"
import { resolveWorkerConfig } from "./src/senpi/workerConfig.ts"

// 没有 worker 配置 = 这台机器不在池子里。安静退出而不是报错:这个脚本的路径可能被留在某个
// settings 里,跑在一台已经退出池子的机器上,而那不是需要打扰任何人的事。
const config = resolveWorkerConfig(process.env)
if (config) await runHook(createHookDeps(config, process.env))
process.exit(0)
