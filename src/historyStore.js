'use strict';

/**
 * Get all histories from global state.
 * @param {{ get: Function }} globalState
 * @returns {Array<object>}
 */
function getHistories(globalState) {
  return globalState.get('histories', []);
}

/**
 * Add a new history to the front of the list.
 * @param {{ get: Function, update: Function }} globalState
 * @param {object} history
 * @returns {Promise<Array<object>>} updated list
 */
async function addHistory(globalState, history) {
  const histories = getHistories(globalState);
  histories.unshift(history);
  await globalState.update('histories', histories);
  return histories;
}

/**
 * Update an existing history by id (mutates matching entry).
 * @param {{ get: Function, update: Function }} globalState
 * @param {string} id
 * @param {Partial<object>} updates
 * @returns {Promise<object|null>} updated entry or null if not found
 */
async function updateHistory(globalState, id, updates) {
  const histories = getHistories(globalState);
  const h = histories.find(x => x.id === id);
  if (!h) return null;
  Object.assign(h, updates);
  await globalState.update('histories', histories);
  return h;
}

/**
 * Remove a history by id.
 * @param {{ get: Function, update: Function }} globalState
 * @param {string} id
 * @returns {Promise<void>}
 */
async function removeHistory(globalState, id) {
  const histories = getHistories(globalState).filter(x => x.id !== id);
  await globalState.update('histories', histories);
}

module.exports = { getHistories, addHistory, updateHistory, removeHistory };
