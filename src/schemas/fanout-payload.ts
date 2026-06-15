import type { z } from "zod";
import { InboxPayloadSchema } from "./inbox-payload";

export const FanoutPayloadSchema = InboxPayloadSchema;
export type FanoutPayload = z.infer<typeof FanoutPayloadSchema>;
