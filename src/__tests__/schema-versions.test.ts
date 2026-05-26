import { describe, test, expect } from 'bun:test';
import {
  CURRENT_WORKPIECE_VERSION,
  SUPPORTED_WORKPIECE_VERSIONS,
  validateWorkpieceVersion,
  stampWorkpieceVersion,
  UnsupportedSchemaVersionError,
} from '../schemas/workpiece';
import {
  CURRENT_INBOX_PAYLOAD_VERSION,
  SUPPORTED_INBOX_PAYLOAD_VERSIONS,
  validateInboxPayloadVersion,
  stampInboxPayloadVersion,
} from '../schemas/inbox-payload';
import { createWorkpiece } from '../workpiece';
import { LineName } from '../ids';

describe('workpiece schema version', () => {
  test('createWorkpiece stamps schema_version: 1', () => {
    const wp = createWorkpiece(LineName('test-line'), 'test task');
    expect(wp.schema_version).toBe(1);
  });

  test('roundtrip: JSON.stringify → parse → validate preserves version', () => {
    const wp = createWorkpiece(LineName('test-line'), 'test task');
    const raw = JSON.parse(JSON.stringify(wp));
    const result = validateWorkpieceVersion(raw);
    expect(result.schema_version).toBe(1);
  });

  test('missing schema_version defaults to 1', () => {
    const raw = { id: 'test', line: 'l', task: 't', input: {}, stations: {} };
    const result = validateWorkpieceVersion(raw);
    expect(result.schema_version).toBe(1);
  });

  test('unknown version 99 throws UnsupportedSchemaVersionError', () => {
    const raw = { schema_version: 99, id: 'test' };
    expect(() => validateWorkpieceVersion(raw)).toThrow(UnsupportedSchemaVersionError);
    try {
      validateWorkpieceVersion(raw);
    } catch (err) {
      expect((err as UnsupportedSchemaVersionError).got).toBe(99);
      expect((err as UnsupportedSchemaVersionError).supported).toEqual([1]);
      expect((err as UnsupportedSchemaVersionError).message).toContain('unsupported_schema_version');
      expect((err as UnsupportedSchemaVersionError).message).toContain('got=99');
      expect((err as UnsupportedSchemaVersionError).message).toContain('supported=[1]');
    }
  });

  test('string version "1" throws UnsupportedSchemaVersionError', () => {
    const raw = { schema_version: '1', id: 'test' };
    expect(() => validateWorkpieceVersion(raw as any)).toThrow(UnsupportedSchemaVersionError);
  });

  test('stampWorkpieceVersion adds field', () => {
    const result = stampWorkpieceVersion({ id: 'x', line: 'l', task: 't' });
    expect(result.schema_version).toBe(CURRENT_WORKPIECE_VERSION);
    expect(result.id).toBe('x');
  });

  test('version constants are consistent', () => {
    expect(SUPPORTED_WORKPIECE_VERSIONS).toContain(CURRENT_WORKPIECE_VERSION);
  });
});

describe('inbox payload schema version', () => {
  test('stampInboxPayloadVersion adds schema_version: 1', () => {
    const result = stampInboxPayloadVersion({ task: 'test', input: {} });
    expect(result.schema_version).toBe(1);
  });

  test('missing schema_version defaults to 1', () => {
    const raw = { task: 'test', input: {} };
    const result = validateInboxPayloadVersion(raw);
    expect(result.schema_version).toBe(1);
  });

  test('unknown version throws UnsupportedSchemaVersionError', () => {
    const raw = { schema_version: 42, task: 'test' };
    expect(() => validateInboxPayloadVersion(raw)).toThrow(UnsupportedSchemaVersionError);
  });

  test('version constants are consistent', () => {
    expect(SUPPORTED_INBOX_PAYLOAD_VERSIONS).toContain(CURRENT_INBOX_PAYLOAD_VERSION);
  });
});

describe('UnsupportedSchemaVersionError', () => {
  test('has correct fields and message format', () => {
    const err = new UnsupportedSchemaVersionError(99, [1]);
    expect(err.got).toBe(99);
    expect(err.supported).toEqual([1]);
    expect(err.message).toBe('unsupported_schema_version: got=99 supported=[1]');
    expect(err).toBeInstanceOf(Error);
  });
});
