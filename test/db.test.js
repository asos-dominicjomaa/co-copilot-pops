'use strict';

const { parseDbOutput, getSqlite3, queryDbValue, queryDbValueAsync, _resetSqlite3Cache } = require('../src/db');

describe('parseDbOutput', () => {
  test('parses single key|value line', () => {
    const result = parseDbOutput('chat.index|{"entries":{}}');
    expect(result['chat.index']).toEqual({ entries: {} });
  });

  test('parses multiple lines', () => {
    const out = 'key1|"hello"\nkey2|42\nkey3|{"x":1}';
    const result = parseDbOutput(out);
    expect(result.key1).toBe('hello');
    expect(result.key2).toBe(42);
    expect(result.key3).toEqual({ x: 1 });
  });

  test('sets null for unparseable JSON', () => {
    const result = parseDbOutput('bad|not-json');
    expect(result['bad']).toBeNull();
  });

  test('ignores lines without pipe separator', () => {
    const result = parseDbOutput('nopipe\nkey|"val"');
    expect(result['nopipe']).toBeUndefined();
    expect(result['key']).toBe('val');
  });

  test('returns empty object for empty string', () => {
    expect(parseDbOutput('')).toEqual({});
  });
});

describe('getSqlite3', () => {
  beforeEach(() => _resetSqlite3Cache());

  test('returns path when exec succeeds', () => {
    const execFn = jest.fn(); // doesn't throw = success
    const result = getSqlite3(execFn);
    expect(result).toBe('/usr/bin/sqlite3');
    expect(execFn).toHaveBeenCalledWith('/usr/bin/sqlite3', ['--version']);
  });

  test('tries next binary when first fails', () => {
    let callCount = 0;
    const execFn = jest.fn((bin) => {
      if (callCount++ === 0) throw new Error('not found');
    });
    const result = getSqlite3(execFn);
    expect(result).toBe('/usr/local/bin/sqlite3');
  });

  test('throws when all binaries fail', () => {
    _resetSqlite3Cache();
    const execFn = jest.fn(() => { throw new Error('not found'); });
    expect(() => getSqlite3(execFn)).toThrow('sqlite3 not found');
  });

  test('returns cached result on second call', () => {
    const execFn = jest.fn();
    getSqlite3(execFn);
    getSqlite3(execFn);
    expect(execFn).toHaveBeenCalledTimes(1);
  });
});

describe('queryDbValue', () => {
  beforeEach(() => _resetSqlite3Cache());

  test('returns parsed value for single key', () => {
    const execFn = jest.fn((bin, args, opts) => Buffer.from('mykey|{"hello":"world"}'));
    const result = queryDbValue('/fake/db', 'mykey', { execFn });
    expect(result).toEqual({ hello: 'world' });
  });

  test('returns null when key not found', () => {
    const execFn = jest.fn(() => Buffer.from(''));
    const result = queryDbValue('/fake/db', 'missing', { execFn });
    expect(result).toBeNull();
  });

  test('returns map for array of keys', () => {
    const execFn = jest.fn(() => Buffer.from('k1|1\nk2|2'));
    const result = queryDbValue('/fake/db', ['k1', 'k2'], { execFn });
    expect(result).toEqual({ k1: 1, k2: 2 });
  });

  test('returns empty map on error for array', () => {
    const execFn = jest.fn(() => { throw new Error('fail'); });
    const result = queryDbValue('/fake/db', ['k1'], { execFn });
    expect(result).toEqual({});
  });

  test('returns null on error for single key', () => {
    const execFn = jest.fn(() => { throw new Error('fail'); });
    const result = queryDbValue('/fake/db', 'k1', { execFn });
    expect(result).toBeNull();
  });
});

describe('queryDbValueAsync', () => {
  beforeEach(() => _resetSqlite3Cache());

  test('returns parsed value for single key', async () => {
    const execFileAsync = jest.fn().mockResolvedValue({ stdout: 'akey|"thevalue"' });
    // need getSqlite3 to have a cached result
    const execFn = jest.fn();
    getSqlite3(execFn); // prime the cache
    const result = await queryDbValueAsync('/db', 'akey', { execFileAsync });
    expect(result).toBe('thevalue');
  });

  test('returns empty map on async error', async () => {
    const execFileAsync = jest.fn().mockRejectedValue(new Error('fail'));
    const execFn = jest.fn();
    getSqlite3(execFn);
    const result = await queryDbValueAsync('/db', ['k1'], { execFileAsync });
    expect(result).toEqual({});
  });
});
