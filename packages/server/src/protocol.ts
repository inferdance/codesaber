import { z } from "zod";

/**
 * Wire protocol (client → server). Zod-validated at the socket boundary:
 * malformed messages get an error ack, never reach the agent.
 */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    since: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal("unsubscribe"),
    sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  }),
  z.object({
    type: z.literal("prompt"),
    commandId: z.string().min(1).max(128),
    sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
    text: z.string().min(1).max(100_000),
  }),
  z.object({
    type: z.literal("steer"),
    commandId: z.string().min(1).max(128),
    sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    text: z.string().min(1).max(100_000),
  }),
  z.object({
    type: z.literal("abort"),
    commandId: z.string().min(1).max(128),
    sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    turnId: z.string().min(1).max(64),
  }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
