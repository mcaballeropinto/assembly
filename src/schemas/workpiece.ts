export const CURRENT_WORKPIECE_VERSION = 1 as const;
export const SUPPORTED_WORKPIECE_VERSIONS = [1] as const;

export class UnsupportedSchemaVersionError extends Error {
  constructor(
    public readonly got: number,
    public readonly supported: readonly number[]
  ) {
    super(`unsupported_schema_version: got=${got} supported=[${supported.join(',')}]`);
    this.name = 'UnsupportedSchemaVersionError';
  }
}

export function validateWorkpieceVersion(raw: Record<string, unknown>): Record<string, unknown> {
  // Default missing schema_version to 1 for back-compat
  if (raw.schema_version === undefined || raw.schema_version === null) {
    raw.schema_version = 1;
    return raw;
  }

  // Reject non-numeric versions
  if (typeof raw.schema_version !== 'number') {
    throw new UnsupportedSchemaVersionError(NaN, SUPPORTED_WORKPIECE_VERSIONS);
  }

  // Reject unsupported versions
  if (!(SUPPORTED_WORKPIECE_VERSIONS as readonly number[]).includes(raw.schema_version)) {
    throw new UnsupportedSchemaVersionError(raw.schema_version, SUPPORTED_WORKPIECE_VERSIONS);
  }

  return raw;
}

export function stampWorkpieceVersion<T extends Record<string, unknown>>(
  obj: T
): T & { schema_version: number } {
  return { ...obj, schema_version: CURRENT_WORKPIECE_VERSION };
}
