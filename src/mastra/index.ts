import { Mastra } from '@mastra/core';
import { MastraEditor } from '@mastra/editor';
import { LibSQLStore } from '@mastra/libsql';
import { PinoLogger } from '@mastra/loggers';
import { getOrderStatus } from './tools/get-order-status';

const storage = new LibSQLStore({
  id: 'mastra-storage',
  // DB is the source of truth for stored agents + their versions.
  // This is the whole point: promotion is driven by data, not Git branches.
  url: 'file:./envs.db',
});

export const mastra = new Mastra({
  storage,
  // Tools are registered on the Mastra instance by key. A *stored* agent
  // references a tool by this key; at runtime the editor resolves it via
  // `mastra.getToolById('get-order-status')`. If the key isn't registered here,
  // the stored agent silently won't get the tool.
  tools: { 'get-order-status': getOrderStatus },
  // Use a non-default port so this demo doesn't collide with another
  // `mastra dev` that may already be running on 4111.
  server: {
    port: Number(process.env.PORT ?? 4222),
  },
  // The agent in this demo is created entirely via the editor API at runtime
  // (a fully *stored* agent), so there are no code-defined agents here.
  // It uses a real model (OpenAI gpt-5.4-mini); set OPENAI_API_KEY before running.
  logger: new PinoLogger({ name: 'environments-demo', level: 'warn' }),
  // `source: 'db'` keeps editor-owned entities in LibSQL and avoids the
  // GitHub source-control path — exactly the "no Git-per-environment" story.
  editor: new MastraEditor({ source: 'db' }),
});
