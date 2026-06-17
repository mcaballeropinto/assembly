import { z } from "zod";
import { WorkpieceId } from "../types";
import { UnsupportedSchemaVersionError } from './workpiece';

export const CURRENT_INBOX_PAYLOAD_VERSION = 1 as const;
export const SUPPORTED_INBOX_PAYLOAD_VERSIONS = [1] as const;

export function validateInboxPayloadVersion(raw: Record<string, unknown>): Record<string, unknown> {
  // Default missing schema_version to 1 for back-compat
  if (raw.schema_version === undefined || raw.schema_version === null) {
    raw.schema_version = 1;
    return raw;
  }

  // Reject non-numeric versions
  if (typeof raw.schema_version !== 'number') {
    throw new UnsupportedSchemaVersionError(NaN, SUPPORTED_INBOX_PAYLOAD_VERSIONS);
  }

  // Reject unsupported versions
  if (!(SUPPORTED_INBOX_PAYLOAD_VERSIONS as readonly number[]).includes(raw.schema_version)) {
    throw new UnsupportedSchemaVersionError(raw.schema_version, SUPPORTED_INBOX_PAYLOAD_VERSIONS);
  }

  return raw;
}

export function stampInboxPayloadVersion<T extends Record<string, unknown>>(
  obj: T
): T & { schema_version: number } {
  return { ...obj, schema_version: CURRENT_INBOX_PAYLOAD_VERSION };
}

const InboxPayloadVersionSchema = z.preprocess((value) => {
  const raw = { schema_version: value } as Record<string, unknown>;
  validateInboxPayloadVersion(raw);
  return raw.schema_version;
}, z.literal(CURRENT_INBOX_PAYLOAD_VERSION));

export const InboxPayloadSchema = z.object({
  schema_version: InboxPayloadVersionSchema.optional().default(CURRENT_INBOX_PAYLOAD_VERSION),
  task: z.string(),
  input: z.record(z.unknown()),
  taskKey: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  source_workpiece_id: z.string().transform((s) => WorkpieceId(s)).optional(),
}).strict();

export type InboxPayload = z.infer<typeof InboxPayloadSchema>;
