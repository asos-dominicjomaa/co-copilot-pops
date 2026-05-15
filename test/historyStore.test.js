'use strict';

const { getHistories, addHistory, updateHistory, removeHistory } = require('../src/historyStore');

function makeState(initial = []) {
  let data = [...initial];
  return {
    get: jest.fn((key, def) => key === 'histories' ? data : def),
    update: jest.fn(async (key, val) => { if (key === 'histories') data = val; }),
    _data: () => data,
  };
}

describe('getHistories', () => {
  test('returns histories from globalState', () => {
    const state = makeState([{ id: '1', name: 'A' }]);
    expect(getHistories(state)).toEqual([{ id: '1', name: 'A' }]);
  });

  test('returns empty array when not set', () => {
    const state = makeState();
    expect(getHistories(state)).toEqual([]);
  });
});

describe('addHistory', () => {
  test('prepends new history to list', async () => {
    const state = makeState([{ id: '1', name: 'existing' }]);
    await addHistory(state, { id: '2', name: 'new' });
    expect(state._data()[0]).toEqual({ id: '2', name: 'new' });
    expect(state._data()).toHaveLength(2);
  });

  test('persists via globalState.update', async () => {
    const state = makeState();
    await addHistory(state, { id: 'x', name: 'test' });
    expect(state.update).toHaveBeenCalledWith('histories', [{ id: 'x', name: 'test' }]);
  });
});

describe('updateHistory', () => {
  test('updates matching history fields', async () => {
    const state = makeState([{ id: '1', name: 'Old', sessionCount: 0 }]);
    const result = await updateHistory(state, '1', { name: 'New', sessionCount: 5 });
    expect(result.name).toBe('New');
    expect(result.sessionCount).toBe(5);
  });

  test('returns null when id not found', async () => {
    const state = makeState();
    expect(await updateHistory(state, 'missing', { name: 'x' })).toBeNull();
  });

  test('does not affect other histories', async () => {
    const state = makeState([{ id: '1', name: 'A' }, { id: '2', name: 'B' }]);
    await updateHistory(state, '1', { name: 'A-updated' });
    expect(state._data()[1].name).toBe('B');
  });
});

describe('removeHistory', () => {
  test('removes history by id', async () => {
    const state = makeState([{ id: '1', name: 'A' }, { id: '2', name: 'B' }]);
    await removeHistory(state, '1');
    expect(state._data()).toHaveLength(1);
    expect(state._data()[0].id).toBe('2');
  });

  test('does nothing when id not found', async () => {
    const state = makeState([{ id: '1', name: 'A' }]);
    await removeHistory(state, 'missing');
    expect(state._data()).toHaveLength(1);
  });
});
