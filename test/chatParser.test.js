'use strict';

const {
  applyJsonlPatch,
  parseJsonlSession,
  extractResponseText,
  loadChatSessionFile,
  loadCopilotCliEvents,
} = require('../src/chatParser');

describe('applyJsonlPatch', () => {
  test('sets a top-level key', () => {
    const obj = { a: 1 };
    applyJsonlPatch(obj, ['b'], 2);
    expect(obj.b).toBe(2);
  });

  test('sets a nested key', () => {
    const obj = { x: { y: 0 } };
    applyJsonlPatch(obj, ['x', 'y'], 99);
    expect(obj.x.y).toBe(99);
  });

  test('appends arrays when both values are arrays', () => {
    const obj = { arr: [1, 2] };
    applyJsonlPatch(obj, ['arr'], [3, 4]);
    expect(obj.arr).toEqual([1, 2, 3, 4]);
  });

  test('sets array index', () => {
    const obj = { list: ['a', 'b'] };
    applyJsonlPatch(obj, ['list', '1'], 'z');
    expect(obj.list).toEqual(['a', 'z']);
  });

  test('does nothing for missing intermediate path', () => {
    const obj = { a: null };
    applyJsonlPatch(obj, ['a', 'b', 'c'], 'x');
    expect(obj.a).toBeNull();
  });
});

describe('extractResponseText', () => {
  test('extracts plain value parts', () => {
    const parts = [{ value: 'Hello ' }, { value: 'world' }];
    expect(extractResponseText(parts)).toBe('Hello world');
  });

  test('extracts markdownContent parts', () => {
    const parts = [{ kind: 'markdownContent', content: { value: '## Title' } }];
    expect(extractResponseText(parts)).toBe('## Title');
  });

  test('skips unrecognised kinds', () => {
    const parts = [{ kind: 'code', value: 'console.log()' }, { value: 'ok' }];
    expect(extractResponseText(parts)).toBe('ok');
  });

  test('returns empty string for empty array', () => {
    expect(extractResponseText([])).toBe('');
  });
});

describe('parseJsonlSession', () => {
  const makeReadFileSync = (content) => jest.fn(() => content);

  test('builds session from kind:0 base', () => {
    const line = JSON.stringify({ kind: 0, v: { sessionId: 'abc', requests: [] } });
    const readFileSync = makeReadFileSync(line + '\n');
    const result = parseJsonlSession('/fake.jsonl', { readFileSync });
    expect(result).toEqual({ sessionId: 'abc', requests: [] });
  });

  test('applies kind:2 patches', () => {
    const base = JSON.stringify({ kind: 0, v: { title: 'old', requests: [] } });
    const patch = JSON.stringify({ kind: 2, k: ['title'], v: 'new' });
    const readFileSync = makeReadFileSync(base + '\n' + patch + '\n');
    const result = parseJsonlSession('/fake.jsonl', { readFileSync });
    expect(result.title).toBe('new');
  });

  test('returns null when no kind:0 line', () => {
    const readFileSync = makeReadFileSync('{"kind":2,"k":["x"],"v":1}\n');
    expect(parseJsonlSession('/fake.jsonl', { readFileSync })).toBeNull();
  });

  test('skips malformed lines', () => {
    const base = JSON.stringify({ kind: 0, v: { title: 't' } });
    const readFileSync = makeReadFileSync(base + '\nnot-json\n');
    expect(parseJsonlSession('/fake.jsonl', { readFileSync })).not.toBeNull();
  });
});

describe('loadChatSessionFile', () => {
  test('extracts turns from .jsonl file', () => {
    const session = {
      requests: [{
        message: { text: 'Hello?' },
        response: [{ value: 'Hi!' }],
        modelId: 'copilot/gpt-4',
        timestamp: 1000,
      }]
    };
    const base = JSON.stringify({ kind: 0, v: session });
    const readFileSync = jest.fn(() => base);
    const turns = loadChatSessionFile('/session.jsonl', { readFileSync });
    expect(turns).toHaveLength(1);
    expect(turns[0].user).toBe('Hello?');
    expect(turns[0].ai).toBe('Hi!');
    expect(turns[0].model).toBe('gpt-4');
  });

  test('extracts turns from .json file', () => {
    const session = { requests: [{ message: { text: 'Q' }, response: [{ value: 'A' }] }] };
    const readFileSync = jest.fn(() => JSON.stringify(session));
    const turns = loadChatSessionFile('/session.json', { readFileSync });
    expect(turns).toHaveLength(1);
    expect(turns[0].user).toBe('Q');
  });

  test('returns null for empty requests', () => {
    const session = { requests: [] };
    const readFileSync = jest.fn(() => JSON.stringify({ kind: 0, v: session }));
    expect(loadChatSessionFile('/s.jsonl', { readFileSync })).toBeNull();
  });

  test('returns null on read error', () => {
    const readFileSync = jest.fn(() => { throw new Error('ENOENT'); });
    expect(loadChatSessionFile('/s.jsonl', { readFileSync })).toBeNull();
  });
});

describe('loadCopilotCliEvents', () => {
  const makeReadFileSync = (events) => {
    const content = events.map(e => JSON.stringify(e)).join('\n');
    return jest.fn(() => content);
  };

  test('pairs user.message with assistant.message by interactionId', () => {
    const events = [
      { type: 'user.message', data: { content: 'What is 2+2?', interactionId: 'i1' }, id: 'e1', timestamp: '2025-01-01T00:00:00.000Z' },
      { type: 'assistant.message', data: { content: '4', interactionId: 'i1' }, id: 'e2' },
    ];
    const readFileSync = makeReadFileSync(events);
    const turns = loadCopilotCliEvents('/events.jsonl', { readFileSync });
    expect(turns).toHaveLength(1);
    expect(turns[0].user).toBe('What is 2+2?');
    expect(turns[0].ai).toBe('4');
  });

  test('strips <userRequest> wrapper', () => {
    const events = [
      { type: 'user.message', data: { content: '<reminder>ignore</reminder><userRequest>clean text</userRequest>', interactionId: 'i1' }, id: 'e1', timestamp: '2025-01-01T00:00:00Z' },
      { type: 'assistant.message', data: { content: 'ok', interactionId: 'i1' }, id: 'e2' },
    ];
    const readFileSync = makeReadFileSync(events);
    const turns = loadCopilotCliEvents('/events.jsonl', { readFileSync });
    expect(turns[0].user).toBe('clean text');
  });

  test('strips reminder and attachments when no userRequest tag', () => {
    const events = [
      { type: 'user.message', data: { content: '<reminder>ignore</reminder><attachments>also ignore</attachments>real message', interactionId: 'i1' }, id: 'e1', timestamp: '2025-01-01T00:00:00Z' },
      { type: 'assistant.message', data: { content: 'ok', interactionId: 'i1' }, id: 'e2' },
    ];
    const readFileSync = makeReadFileSync(events);
    const turns = loadCopilotCliEvents('/events.jsonl', { readFileSync });
    expect(turns[0].user).toBe('real message');
  });

  test('concatenates multiple assistant messages for same interaction', () => {
    const events = [
      { type: 'user.message', data: { content: 'Q', interactionId: 'i1' }, id: 'e1', timestamp: '2025-01-01T00:00:00Z' },
      { type: 'assistant.message', data: { content: 'part1', interactionId: 'i1' }, id: 'e2' },
      { type: 'assistant.message', data: { content: 'part2', interactionId: 'i1' }, id: 'e3' },
    ];
    const readFileSync = makeReadFileSync(events);
    const turns = loadCopilotCliEvents('/events.jsonl', { readFileSync });
    expect(turns[0].ai).toBe('part1\npart2');
  });

  test('returns null when no turns found', () => {
    const readFileSync = jest.fn(() => '{"type":"session.start"}\n');
    expect(loadCopilotCliEvents('/events.jsonl', { readFileSync })).toBeNull();
  });

  test('returns null on read error', () => {
    const readFileSync = jest.fn(() => { throw new Error('ENOENT'); });
    expect(loadCopilotCliEvents('/events.jsonl', { readFileSync })).toBeNull();
  });
});
