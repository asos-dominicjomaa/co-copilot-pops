/**
 * @jest-environment jsdom
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Stubs must be on global (= window in jsdom) before the script runs
global.acquireVsCodeApi = jest.fn(() => ({
  postMessage: jest.fn(),
  getState: jest.fn(() => null),
  setState: jest.fn(),
}));

// Provide ALL DOM elements the app.js top-level addEventListener calls expect
document.body.innerHTML = `
  <div id="sidebar"></div>
  <div id="sidebar-divider"></div>
  <div id="divider-arrow"></div>
  <div id="sidebar-title"></div>
  <button id="btn-back" style="display:none"></button>
  <button id="btn-add"></button>
  <button id="btn-export-bundle"></button>
  <button id="btn-backup"></button>
  <button id="btn-save-history"></button>
  <button id="btn-export-chat"></button>
  <button id="btn-find-prev"></button>
  <button id="btn-find-next"></button>
  <button id="btn-copy"></button>
  <button id="btn-export"></button>
  <input id="search" value="" />
  <input id="chat-search" value="" />
  <div id="sidebar-list"></div>
  <div id="content"></div>
  <div id="content-header"></div>
  <div id="session-list"></div>
  <div id="chat-search-bar" style="display:none"></div>
  <div id="chat-search-status"></div>
  <div id="find-counter" style="display:none"></div>
  <div id="backup-status" style="display:none"></div>
  <select id="sort-select"><option value="newest">Newest</option></select>
`;

// Run app.js in this context so function declarations land on global/window
const appSrc = fs.readFileSync(path.join(__dirname, '../../src/webview/app.js'), 'utf8');
const script = document.createElement('script');
script.textContent = appSrc;
document.head.appendChild(script);

// Helper: run a snippet in the same jsdom global scope (can mutate let vars from app.js)
function execScript(code) {
  const s = document.createElement('script');
  s.textContent = code;
  document.head.appendChild(s);
}

// ── Tests for pure utility functions ──

describe('esc', () => {
  test('escapes ampersand', () => expect(window.esc('a&b')).toBe('a&amp;b'));
  test('escapes less-than and greater-than', () => expect(window.esc('<tag>')).toBe('&lt;tag&gt;'));
  test('coerces non-string to string', () => expect(window.esc(42)).toBe('42'));
  test('returns empty string for empty input', () => expect(window.esc('')).toBe(''));
});

describe('fmt', () => {
  test('returns empty string for falsy timestamp', () => expect(window.fmt(0)).toBe(''));
  test('returns a non-empty string for valid timestamp', () => {
    const result = window.fmt(1700000000000);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('hlRaw', () => {
  test('returns esc(str) when no term', () => expect(window.hlRaw('hello', '')).toBe('hello'));
  test('wraps match in <mark>', () => expect(window.hlRaw('Hello world', 'world')).toBe('Hello <mark>world</mark>'));
  test('case-insensitive match', () => expect(window.hlRaw('Hello', 'hello')).toBe('<mark>Hello</mark>'));
  test('escapes html in surrounding context', () => expect(window.hlRaw('<b>find</b>', 'find')).toBe('&lt;b&gt;<mark>find</mark>&lt;/b&gt;'));
  test('handles multiple matches', () => {
    const result = window.hlRaw('cat cat cat', 'cat');
    expect((result.match(/<mark>/g) || []).length).toBe(3);
  });
});

describe('getSorted', () => {
  const sessions = [
    { date: 1000, turnCount: 5, title: 'old' },
    { date: 3000, turnCount: 2, title: 'newest' },
    { date: 2000, turnCount: 8, title: 'mid' },
  ];

  beforeEach(() => execScript(`sortOrder = 'newest';`));

  test('sorts newest-first by default', () => {
    const result = window.getSorted(sessions);
    expect(result[0].title).toBe('newest');
    expect(result[2].title).toBe('old');
  });

  test('sorts oldest-first', () => {
    execScript(`sortOrder = 'oldest';`);
    expect(window.getSorted(sessions)[0].title).toBe('old');
  });

  test('sorts longest-first', () => {
    execScript(`sortOrder = 'longest';`);
    expect(window.getSorted(sessions)[0].turnCount).toBe(8);
  });

  test('does not mutate original array', () => {
    const orig = [...sessions];
    window.getSorted(sessions);
    expect(sessions).toEqual(orig);
  });
});

describe('getFiltered', () => {
  beforeEach(() => {
    execScript(`
      sortOrder = 'newest';
      allSessions = [
        { date: 3000, turnCount: 0, title: 'TypeScript refactor', workspace: 'my-app', turns: [] },
        { date: 2000, turnCount: 0, title: 'Python bug fix', workspace: 'other-project', turns: [] },
        { date: 1000, turnCount: 0, title: 'General chat', workspace: 'my-app', turns: [{ user: 'how to use jest', ai: 'install jest' }] }
      ];
      searchTerm = '';
    `);
  });

  test('returns all sessions when searchTerm empty', () => expect(window.getFiltered()).toHaveLength(3));

  test('filters by title', () => {
    execScript(`searchTerm = 'typescript';`);
    expect(window.getFiltered()).toHaveLength(1);
    expect(window.getFiltered()[0].title).toMatch(/TypeScript/i);
  });

  test('filters by workspace', () => {
    execScript(`searchTerm = 'other-project';`);
    expect(window.getFiltered()).toHaveLength(1);
  });

  test('filters by turn content', () => {
    execScript(`searchTerm = 'jest';`);
    expect(window.getFiltered().some(s => s.title === 'General chat')).toBe(true);
  });
});
