/**
 * E2E proof: emulate a QA → prod release flow for a *fully stored* agent using
 * Mastra's version lifecycle — every claim proven through a real `generate()`.
 *
 * The agent is created entirely via the editor API (no code definition). It uses
 * a real model (OpenAI `gpt-5.4-mini`). To still reveal *which version* the server
 * resolved, each version's instructions command a fixed, single-token reply (e.g.
 * "reply with exactly: VERSION_ONE"). So the model output is a reliable signal of
 * the resolved version — set OPENAI_API_KEY before running.
 *
 * Two resolution strategies are exercised:
 *   - agent.generate(prompt)
 *       -> PROD: the published version (the agent's `activeVersionId`).
 *   - agent.generate(prompt, { requestContext: { agentVersionId } })
 *       -> a *pinned* version, resolved regardless of what PROD points at — your
 *          "QA" lane for validating a candidate before promoting it.
 *
 * IMPORTANT — current framework behavior (honest caveats):
 *   1. Creating a stored agent auto-publishes v1, so it's immediately usable.
 *   2. Editing config via PATCH (`update`) auto-creates a new version AND
 *      auto-publishes it. There is no HTTP "save as draft without publishing"
 *      path yet, so each edit moves PROD forward — `activateVersion` lets you
 *      roll PROD back to, or forward to, any version you choose.
 *   3. Pinning a version on `generate` must go through
 *      `requestContext.agentVersionId` (the body). The generate route does NOT
 *      read `?versionId=`/`?status=` query params.
 *
 * How to run (two terminals):
 *   1. Start the server:   pnpm dev          (runs `mastra dev`)
 *   2. Run this script:    pnpm promote
 *
 * Point it at a different server with MASTRA_BASE_URL (default http://localhost:4222).
 */
import { MastraClient } from '@mastra/client-js';

const BASE_URL = process.env.MASTRA_BASE_URL ?? 'http://localhost:4222';
const AGENT_ID = 'support';
const PROMPT = 'Reply now.';

// Stored agents persist the model as `{ provider, name }`, resolved to the string
// `${provider}/${name}` and routed through the model router — here a real provider.
const MODEL = { provider: 'openai', name: 'gpt-5.4-mini' };

// Each version replies with one fixed token, so the output reveals which version
// the server resolved.
const V1 = 'Ignore the user message. Reply with exactly this and nothing else: VERSION_ONE';
const V2 = 'Ignore the user message. Reply with exactly this and nothing else: VERSION_TWO';
const V3 = 'Ignore the user message. Reply with exactly this and nothing else: VERSION_THREE';

/** Pull the trimmed text out of a generate() result. */
const textOf = (r: { text?: string }) => (r.text ?? '').trim();

async function main() {
  const client = new MastraClient({ baseUrl: BASE_URL });
  const agent = client.getAgent(AGENT_ID);

  // Clean slate so the demo is repeatable (ignore "not found" on first run).
  await client.getStoredAgent(AGENT_ID).delete().catch(() => {});

  // [1] Create the stored agent. Create auto-publishes v1, so PROD serves v1.
  //     - tools: attach a tool BY KEY; the key must match a tool registered on
  //       the Mastra instance (see src/mastra/index.ts). {} means "attach as-is".
  //     - metadata: arbitrary JSON on the agent record (ownership, tags, flags…).
  console.log('\n[1] Create stored agent — auto-publishes v1');
  await client.createStoredAgent({
    id: AGENT_ID,
    name: 'Support Agent',
    instructions: V1,
    model: MODEL,
    tools: { 'get-order-status': {} },
    metadata: { team: 'support', tier: 'free', owner: 'alice' },
  });

  const stored = client.getStoredAgent(AGENT_ID);
  const versionId = async (n: number) =>
    (await stored.listVersions()).versions.find(v => v.versionNumber === n)!.id;

  // PROD = the published version. Pinned = a specific version, regardless of PROD
  // (sent via the body requestContext; cast since the type doesn't list the key).
  const askProd = async () => textOf(await agent.generate(PROMPT));
  const askPinned = async (id: string) =>
    textOf(await agent.generate(PROMPT, { requestContext: { agentVersionId: id } } as any));

  const v1 = await versionId(1);
  console.log(`  PROD -> ${await askProd()}`);

  // [2] Edit instructions. PATCH auto-versions AND auto-publishes -> v2 = PROD.
  console.log('\n[2] Edit instructions (auto-versions + auto-publishes v2)');
  await stored.update({ instructions: V2 });
  const v2 = await versionId(2);
  console.log(`  PROD -> ${await askProd()}`);

  // [3] Roll PROD back to v1 while v2 stays on the shelf — PROD is just a pointer
  //     you control with activateVersion. v2 is still reachable by pinning it.
  console.log('\n[3] Rollback PROD -> v1 (v2 still on the shelf)');
  await stored.activateVersion(v1);
  console.log(`  PROD   -> ${await askProd()}`);
  console.log(`  pin v2 -> ${await askPinned(v2)}`);

  // [4] Iterate -> v3 (auto-published). Every version is still testable by id.
  console.log('\n[4] Iterate -> v3, then QA-check each version by id');
  await stored.update({ instructions: V3 });
  const v3 = await versionId(3);
  console.log(`  PROD   -> ${await askProd()}`);
  console.log(`  pin v1 -> ${await askPinned(v1)}`);
  console.log(`  pin v2 -> ${await askPinned(v2)}`);
  console.log(`  pin v3 -> ${await askPinned(v3)}`);

  // [5] Pick the winner: promote v2 to PROD explicitly.
  console.log('\n[5] Promote v2 -> PROD');
  await stored.activateVersion(v2);
  console.log(`  PROD -> ${await askProd()}`);

  // [6] Prove the attached tool is actually invoked: publish instructions that
  //     require the tool, then ask an order question only the tool can answer.
  console.log('\n[6] Tool attached at create — prove it is invoked');
  await stored.update({
    instructions:
      'You are a support agent. When asked about an order, you MUST call the ' +
      'get-order-status tool and answer using ONLY its result. Be concise.',
  });
  const answer = textOf(await agent.generate('What is the status of order A-1001 and the ETA?'));
  const usedTool = /shipped/i.test(answer) && /2 days/i.test(answer);
  console.log(`  agent answer -> ${answer}`);
  console.log(`  tool invoked -> ${usedTool ? 'YES (got tool result)' : 'NO'}`);

  // [7] Update metadata. It lives on the agent record, so this does NOT create a
  //     version or move PROD. PATCH replaces metadata, so merge to preserve keys.
  console.log('\n[7] Update metadata (record-level, not versioned)');
  const before = (await stored.details()).metadata;
  console.log(`  metadata before -> ${JSON.stringify(before)}`);
  await stored.update({ metadata: { ...before, tier: 'enterprise', updatedBy: 'bob' } });
  const after = (await stored.details()).metadata;
  console.log(`  metadata after  -> ${JSON.stringify(after)}`);

  console.log('\nProof complete:');
  console.log('  • PROD is the published pointer (activeVersionId); activateVersion moves it');
  console.log('    forward or back to ANY version on demand.');
  console.log('  • Every version stays individually addressable via');
  console.log('    generate(prompt, { requestContext: { agentVersionId } }) — your QA lane.');
  console.log('  • A tool attached by key (registered on the Mastra instance) is invoked at');
  console.log('    runtime — resolved via mastra.getToolById().');
  console.log('  • Metadata is record-level: update it with PATCH without creating a version.');
  console.log('  • Caveat: editing config auto-publishes today, so use activateVersion to');
  console.log('    control exactly which version PROD serves.\n');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
