# Agent Note: Keep per-Session MCP browser tools out of the global tool layer

Status: implemented

English | [中文](2026-09-17-mcp-browser-tools-per-session-scope.zh.md)

## Problem

On a machine whose profile mounts the Playwright browser provider, every Session created or resumed after that provider activated failed. Cordis first reported `mcp-client(playwright-mcp): initial connection or tool synchronization failed`; with the advertised input schema normalized, the same conflict surfaced as `tool "mcp__playwright-mcp__browser_close" is already registered (for a per-agent variant, register through that agent's `agent.ctx` instead)`. Because `mountSessionMcp` sets `failOnStartupError: true`, the second Session's failed mount rolled back Agent creation or resume, and the Web client removed the clicked Session from the sidebar.

`mountSessionMcp` mints each Session's registration scope with `createScope`, and that scope tag was a module-local symbol. A DSH profile installs plugin packages into its own `node_modules`, and `@deepseek-ai/dsh-experimental-browser-use-runtime` declared `@deepseek-ai/dsh-scope` as an ordinary dependency, so the profile held a second physical copy of the package. The provider wrote the tag with the profile copy while `dsh-tools` read it with the harness copy, so `scopeOf()` returned `undefined` and the browser tools were registered in the global tool layer. `dsh-mcp-client` reads the tag from the same profile copy, so its per-`serverName` reservation stayed per-Session and the collision appeared as a tool-name conflict rather than a namespace conflict.

`dsh-mcp-client` also passed an advertised `inputSchema` straight into registration while an unsupported `outputSchema` degraded to the unconstrained schema. The subset checker accepts `type`/`oneOf`/`properties`/`required`/`additionalProperties`/`items`/`enum`/`const` plus annotations, and `@playwright/mcp@0.0.80` advertises `$schema` on all 24 tools, `propertyNames` and a subschema-valued `additionalProperties` on one, and `minimum`/`maximum` on another. That asymmetry is latent rather than load-bearing — registration validates `output.schema` only, and `parameters` reaches providers verbatim — so it is recorded here as a real inconsistency this provider exposes, not as the outage cause.

## Decision

`dsh-scope` identity is process-global. The context tag is `Symbol.for('dsh-scope.context-tag')`, and the scope-parent relation and carrier marks share one process-global slot installed through `Symbol.for('dsh-scope.identity')` on `globalThis`, so an independently installed copy reads what another copy wrote ([source](../../../../packages/core/scope/src/index.ts)).

`@deepseek-ai/dsh-experimental-browser-use-runtime` declares `@deepseek-ai/dsh-scope` in matching `peerDependencies` and `devDependencies`, joining every other scope consumer; a profile install now resolves the harness copy instead of materializing a second one ([source](../../../../packages/experimental/browser-use-runtime/package.json)).

`dsh-mcp-client` normalizes an advertised input schema into the enforced subset through `normalizeAdvertisedJsonSchema` in `dsh-tools`: supported keywords survive, unknown vocabulary is removed, `required` is filtered to surviving properties, a subschema-valued `additionalProperties` becomes the open default, `oneOf` wins over sibling constraints and is dropped when a branch would become unconstrained, and an unrepresentable root degrades to the unconstrained schema ([source](../../../../packages/core/tools/src/json-schema.ts)).

Launch mode allows one browser per live Session. Concurrent Sessions each own an isolated Chromium connection, and the mount stays per-Session.

## Alternatives considered

**Register through `agent.ctx` only.** `dsh-mcp-client`'s own `scopeOf` would still miss the tag from the other copy, so its `serverName` reservation would fall back to the app root and the second Session would fail on `serverName "playwright-mcp" is already in use`. The shared package instance is the invariant; one reader changing where it mounts does not restore it.

**Fix the peer declaration only.** A duplicated install would still silently turn a per-Session registration into a global one, and nothing in the workspace resolves two copies, so no behavioral test could catch it. The identity fix makes the primitive correct under duplication; the peer declaration removes the duplication.

**Drop an unsupported input schema the way an unsupported output schema is dropped.** The model would lose the parameter description it needs to call the tool. Normalizing keeps every supported constraint and the model-facing parameter contract.

**Let a failed browser startup degrade to a Session without browser tools.** That would have hidden this defect behind silent capability loss. The provider's activation contract treats browser tools as part of the Session, and the defect was registration scope, not startup policy.

## Consequences

Per-Session scope identity now survives an independently installed copy: `scopeOf`, the parent chain, and carrier marks are one world per process, whatever copy wrote them. `dsh-scope` keeps one process-global slot on `globalThis`, matching how Cordis brands its context across copies.

A model-facing input schema can now be weaker than the advertised one: values that only an unsupported keyword excluded reach the MCP server, which reports the violation as an ordinary tool error. Every supported constraint is preserved, and an unrepresentable root still degrades to unconstrained JSON.

`copies.spec.ts` loads `dsh-scope` twice in one process and asserts both copies read the same tag, parent chain, and carrier marks; it fails on the pre-fix module-local symbol. `apply.spec.ts` registers a tool whose advertised input schema carries `$schema`, `propertyNames`, `minimum`, and a subschema-valued `additionalProperties` under `failOnStartupError: true`. `mcp.spec.ts` mounts the same provider for two Sessions in launch mode and asserts each Session keeps its own browser and that no browser tool reaches the global layer.
