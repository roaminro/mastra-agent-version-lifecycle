import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/**
 * A tiny, deterministic tool so the demo can PROVE the stored agent actually
 * invokes it. Stored agents reference tools *by key* — at runtime the editor
 * resolves that key via `mastra.getToolById(key)`, so the tool must be
 * registered on the Mastra instance (see src/mastra/index.ts). If the key isn't
 * registered, it's silently skipped with a warning.
 *
 * The tool key the stored agent must reference is this tool's `id`:
 * "get-order-status".
 */
export const getOrderStatus = createTool({
  id: 'get-order-status',
  description: 'Look up the delivery status of a customer order by its order ID.',
  inputSchema: z.object({
    orderId: z.string().describe('The order ID, e.g. "A-1001"'),
  }),
  outputSchema: z.object({
    orderId: z.string(),
    status: z.string(),
    eta: z.string(),
  }),
  execute: async input => {
    // Deterministic fake "database" so output is stable across runs.
    return {
      orderId: input.orderId,
      status: 'shipped',
      eta: '2 days',
    };
  },
});
