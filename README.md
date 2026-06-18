# Environments Demo (without environments)

This example proves — **end-to-end, through `agent.generate()`** — that you can
run a **QA → prod** release flow for a **fully stored agent** using Mastra's
**existing** version lifecycle. No new framework primitives, no
Git-branch-per-environment scheme. The database (not Git) is the source of truth,
and the version you serve is chosen at request time.

The key realization: every stored agent already has

- an immutable **version** history (`versionNumber` 1, 2, 3 …),
- a single **published pointer** (`activeVersionId`) that `generate()` serves by
  default ("PROD"), and
- per-request **version pinning**, so any version stays addressable on demand
  ("QA").

That's enough to model environments as **different version pins of the same
agent** — without standing up separate infrastructure per environment.

## What gets proven

The agent is created entirely via the editor API (no code definition). It uses a
**real model** — OpenAI `gpt-5.4-mini`. To still make the resolved version
observable, each version's instructions command a fixed single-token reply (e.g.
"reply with exactly: VERSION_ONE"). So the model output is a reliable signal of
which version the server resolved.

> Set `OPENAI_API_KEY` in your environment before running.

The script (`src/promote.ts`) drives a realistic loop and asserts behavior via
`generate()` at each step:

1. **Create** the stored agent → create auto-publishes v1, so **PROD serves v1**.
2. **Edit instructions** → PATCH auto-versions **and auto-publishes** v2, so
   **PROD moves to v2**. (See caveat below — this is current framework behavior.)
3. **Rollback** → `activateVersion(v1)` flips PROD back to v1, while v2 stays on
   the shelf and is still reachable by pinning it. *(isolation proof)*
4. **Iterate (v3)** → another auto-published edit moves PROD to v3, yet **every**
   version (v1/v2/v3) remains individually testable by id. *(QA lane)*
5. **Promote** → `activateVersion(v2)` makes PROD serve the chosen winner.
6. **Tool** → a tool attached **by key** at create time is actually **invoked**
   at runtime (the agent answers an order question only the tool can answer).
7. **Metadata** → record-level metadata is **added on create** and **updated via
   PATCH** without creating a new version or moving PROD.

## How a call selects a version (client SDK)

```ts
// PROD: the published version (activeVersionId)
client.getAgent(id).generate(prompt);

// QA: pin a specific version, regardless of what PROD points at.
// NOTE: the generate route reads the pin from requestContext, NOT the URL.
client.getAgent(id).generate(prompt, {
  requestContext: { agentVersionId },
});
```

The default (no pin) path serves the **published** version. Pinning a version is
**opt-in** — normal production traffic never sees a non-published version unless
you explicitly ask for it. That's the dev/prod isolation you want, with no
environment primitive.

## Attaching a tool

A stored agent references tools **by key**. The key must match a tool
**registered on the Mastra instance** — at runtime the editor resolves it via
`mastra.getToolById(key)`. If the key isn't registered, the tool is silently
skipped (with a warning).

```ts
// 1. Register the tool on the Mastra instance (src/mastra/index.ts)
new Mastra({ tools: { 'get-order-status': getOrderStatus } });

// 2. Attach it by key when creating/updating the stored agent.
//    The value is per-tool config ({ description?, rules? }); {} = attach as-is.
client.createStoredAgent({
  id: 'support',
  name: 'Support Agent',
  instructions: '...',
  model: { provider: 'openai', name: 'gpt-5.4-mini' },
  tools: { 'get-order-status': {} },
});
```

Step [6] proves the tool is genuinely invoked: the agent answers an order-status
question using only the tool's result.

> Beyond registry tools, the same create/update payload also accepts
> `mcpClients`, `toolProviders`, `workflows`, `agents` (sub-agents), `skills`,
> `memory`, `scorers`, `inputProcessors`/`outputProcessors`, and more — each
> attachable by key/config.

## Adding & updating metadata

`metadata` is arbitrary JSON on the **agent record** (not the version snapshot),
ideal for ownership, tags, or feature flags. It can be set at create time and
changed later with `update()` (PATCH) — **without** creating a new version or
moving PROD.

```ts
// On create
client.createStoredAgent({ /* ... */, metadata: { team: 'support', tier: 'free' } });

// Update later — PATCH REPLACES the metadata object, so merge to preserve keys.
const { metadata } = await stored.details();
await stored.update({ metadata: { ...metadata, tier: 'enterprise' } });
```

> Gotcha: PATCH **replaces** `metadata` wholesale. Spread the existing object
> (`...metadata`) if you want to preserve other keys.

## Mapping

| Environment concept   | Mastra primitive                                                       |
| --------------------- | --------------------------------------------------------------------- |
| Production            | the **published** version (`getAgent(id)` → `activeVersionId`)         |
| QA / staging check    | a **pinned** version (`generate(prompt, { requestContext: { agentVersionId } })`) |
| Release a new version | `agent.activateVersion(versionId)` (sets `activeVersionId` + published) |
| Rollback              | `agent.activateVersion(priorVersionId)`                               |

## Run it

This is a **standalone** project. It depends on published `@mastra/*` packages
from npm — no monorepo checkout required.

```bash
git clone <your-repo-url>
cd mastra-version-lifecycle-demo

cp .env.example .env   # then set OPENAI_API_KEY
pnpm install
```

Then run it in **two terminals** from this directory:

```bash
# Terminal 1 — start the server with the Mastra CLI (port from src/mastra/index.ts)
pnpm dev

# Terminal 2 — run the demo against the running server
pnpm promote
```

The script talks to the server over HTTP via `@mastra/client-js`. Point it at a
different server with `MASTRA_BASE_URL` (defaults to `http://localhost:4222`).

Expected: PROD follows `activateVersion`, rollback restores a prior version, and
each pinned version returns its own distinct instructions — all proven through
real `generate()` calls.

## Caveats — current framework behavior

This demo is honest about two rough edges it hit, which are useful signals for
where the framework could improve:

1. **Editing config auto-publishes.** Creating a stored agent auto-publishes v1,
   and editing config via `update()` (PATCH) auto-creates a new version **and
   auto-publishes it**. There is no HTTP "save as draft without publishing" path
   today — the server's auto-publish block is explicitly marked *"when a proper
   publish flow ships, this block can be removed"*. So each edit moves PROD
   forward; use `activateVersion` to control exactly which version PROD serves
   (including rolling back).

2. **`generate()` only pins via `requestContext`.** The generate/stream routes
   resolve the pinned version from `requestContext.agentVersionId` (sent in the
   body), **not** from `?versionId=`/`?status=` query params. So
   `getAgent(id, { versionId }).generate(...)` does **not** pin generate today,
   even though `getAgent(id).details({ versionId })` (the `GET /agents/:id`
   route) does honor the query param. Aligning the two would make the SDK's
   version-pinned `getAgent` work consistently across `details` and `generate`.

## What this is — and isn't

**Is:** a per-entity lifecycle (iterate → test a version → promote → rollback)
driven by data, resolved at request time through the real generate path — so you
don't need a Git branch per environment to gate promotion.

**Is not:** separate running infrastructure, per-environment secrets, network
isolation, or per-customer multitenancy. Those remain deployment concerns. This
demo is intentionally **agents-only** and **single-tenant** to keep the mechanics
clear.

> Note: workflows are not yet stored entities (no versions / published pointer),
> so this flow can't be applied to them today. Making workflows DB-stored would
> let them reuse this exact lifecycle.
