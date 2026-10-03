import { z } from "zod";

export const walletSchema = z.string().min(32).max(44);

export const nonceRequestSchema = z.object({
  walletAddress: walletSchema,
}).strict();

export const loginRequestSchema = z.object({
  walletAddress: walletSchema,
  message: z.string().min(1).max(2048),
  signature: z.string().min(1).max(128),
}).strict();
