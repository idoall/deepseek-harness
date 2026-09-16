# Agent Note: Keep per-Session MCP browser tools out of the global tool layer

Status: implemented

[English](2026-09-17-mcp-browser-tools-per-session-scope.md) | 中文

## 问题

在挂载了 Playwright 浏览器 provider 的 profile 上，该 provider 激活之后创建或恢复的每个 Session 都会失败。Cordis 首先报出 `mcp-client(playwright-mcp): initial connection or tool synchronization failed`；在把 advertised input schema 规范化之后，同一个冲突表现为 `tool "mcp__playwright-mcp__browser_close" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`。由于 `mountSessionMcp` 设置了 `failOnStartupError: true`，第二个 Session 的挂载失败会回滚 Agent 的创建或恢复，Web 客户端随后把被点击的 Session 从侧边栏移除。

`mountSessionMcp` 用 `createScope` 为每个 Session 铸造注册作用域，而该作用域标签原本是模块内 symbol。DSH profile 会把插件包安装到自己的 `node_modules`，而 `@deepseek-ai/dsh-experimental-browser-use-runtime` 把 `@deepseek-ai/dsh-scope` 声明为普通 dependency，于是 profile 里存在该包的第二个物理副本。provider 用 profile 副本写入标签，`dsh-tools` 却用 harness 副本读取，因此 `scopeOf()` 返回 `undefined`，浏览器工具被注册到全局工具层。`dsh-mcp-client` 读取标签时用的是同一个 profile 副本，所以它按 `serverName` 做的独占保留仍是按 Session 生效的，冲突便表现为工具重名而不是命名空间重名。

`dsh-mcp-client` 还把 advertised `inputSchema` 原样交给注册，而对不支持的 `outputSchema` 则降级为无约束 schema。子集检查器只接受 `type`/`oneOf`/`properties`/`required`/`additionalProperties`/`items`/`enum`/`const` 加注解，而 `@playwright/mcp@0.0.80` 的 24 个工具全部带 `$schema`，其中一个还带 `propertyNames` 和子 schema 形式的 `additionalProperties`，另一个带 `minimum`/`maximum`。这一不对称是潜在的、而非本次故障的主因——注册只校验 `output.schema`，`parameters` 会原样传给 provider——此处记录它，是因为该 provider 暴露了这处真实的不一致。

## 决策

`dsh-scope` 的身份是进程全局的。上下文标签为 `Symbol.for('dsh-scope.context-tag')`，作用域父子关系与 carrier 标记共享同一个进程全局槽位，通过 `globalThis` 上的 `Symbol.for('dsh-scope.identity')` 安装，因此独立安装的另一份副本能读到别的副本写入的内容（[源码](../../../../packages/core/scope/src/index.ts)）。

`@deepseek-ai/dsh-experimental-browser-use-runtime` 在 `peerDependencies` 与 `devDependencies` 中成对声明 `@deepseek-ai/dsh-scope`，与其他所有 scope 消费方一致；profile 安装现在解析到 harness 的那一份，而不再物化第二份（[源码](../../../../packages/experimental/browser-use-runtime/package.json)）。

`dsh-mcp-client` 通过 `dsh-tools` 的 `normalizeAdvertisedJsonSchema` 把 advertised input schema 规范化进受限子集：受支持的关键字保留，未知词汇移除，`required` 过滤为仍然存在的属性，子 schema 形式的 `additionalProperties` 变为开放默认值，受限子集拒绝 `type` 与 `oneOf` 并存，因此声明的 `type` 获胜、union 被丢弃——工具参数以对象为根，union 只是收窄它——而没有可表示 `type` 的节点保留其 union，除非某个分支会规范化成无约束 schema（[源码](../../../../packages/core/tools/src/json-schema.ts)）。

launch 模式允许每个存活 Session 各持有一个浏览器。并发 Session 各自拥有隔离的 Chromium 连接，挂载始终按 Session 生效。

## 考虑过的替代方案

**只改为通过 `agent.ctx` 注册。** `dsh-mcp-client` 自己的 `scopeOf` 仍然读不到另一份副本写入的标签，于是它的 `serverName` 保留会回落到应用根，第二个 Session 会改为报 `serverName "playwright-mcp" is already in use` 而失败。共享的包实例才是这里的不变量；只改一个读取方挂载到哪里并不能恢复它。

**只修 peer 声明。** 重复安装仍会把按 Session 的注册悄悄变成全局注册，而工作区里任何路径都只会解析出一份副本，因此没有行为测试能抓住它。身份修复让该原语在重复安装下也正确；peer 声明则消除重复安装本身。

**像丢弃不支持的 output schema 那样丢弃不支持的 input schema。** 模型会失去调用工具所需的参数描述。规范化在保留每一条受支持约束的同时，也保住了面向模型的参数约定。

**让浏览器启动失败降级为没有浏览器工具的 Session。** 这会把该缺陷藏在静默的能力丢失之后。provider 的激活约定把浏览器工具视为 Session 的一部分，而本次缺陷在注册作用域，不在启动策略。

## 影响

按 Session 的作用域身份现在能跨越独立安装的副本：`scopeOf`、父子链与 carrier 标记在整个进程内是同一个世界，无论由哪份副本写入。`dsh-scope` 在 `globalThis` 上保留一个进程全局槽位，与 Cordis 跨副本标记其 context 的方式一致。

面向模型的 input schema 现在可能弱于 advertised 的那一份：仅被不支持关键字排除的取值会到达 MCP server，server 以普通工具错误报告该违规。每条受支持的约束都被保留，无法表示的根仍降级为无约束 JSON。

`copies.spec.ts` 在同一进程内加载两份 `dsh-scope`，断言两份副本读到相同的标签、父子链与 carrier 标记；在修复前的模块内 symbol 下它会失败。工具目录测试要求每个已发布工具的 `parameters.type === 'object'`；它否决了「union 优先」的规则——该规则会把同样经这座桥注册的 `stagehand_tabs` 改写成没有 type 的 `oneOf` 根——现在它固定了「声明的 type 优先」。`apply.spec.ts` 在 `failOnStartupError: true` 下注册一个 advertised input schema 带 `$schema`、`propertyNames`、`minimum` 和子 schema 形式 `additionalProperties` 的工具。`mcp.spec.ts` 在 launch 模式下为两个 Session 挂载同一 provider，断言每个 Session 持有自己的浏览器，且没有任何浏览器工具进入全局层。
