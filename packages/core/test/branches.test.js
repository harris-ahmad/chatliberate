import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAllBranches,
  getActivePath,
  countBranches,
  splitBranchesBySharedPrefix,
} from '../dist/index.js';

const sampleConversation = {
  title: 'Branch test',
  current_node: 'asst-b',
  mapping: {
    root: { id: 'root', parent: null, children: ['user-1'], message: null },
    'user-1': {
      id: 'user-1',
      parent: 'root',
      children: ['asst-a', 'asst-b'],
      message: {
        author: { role: 'user' },
        content: { content_type: 'text', parts: ['Hello'] },
      },
    },
    'asst-a': {
      id: 'asst-a',
      parent: 'user-1',
      children: [],
      message: {
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['Response A'] },
      },
    },
    'asst-b': {
      id: 'asst-b',
      parent: 'user-1',
      children: [],
      message: {
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['Response B'] },
      },
    },
  },
};

test('getAllBranches finds every regenerated reply', () => {
  const branches = getAllBranches(sampleConversation);
  assert.equal(branches.length, 2);
});

test('getActivePath follows current_node', () => {
  const path = getActivePath(sampleConversation);
  const texts = path.messages.map((m) => m.content?.parts?.[0]);
  assert.deepEqual(texts, ['Hello', 'Response B']);
});

test('countBranches', () => {
  assert.equal(countBranches(sampleConversation), 2);
});

test('getAllBranches finds nested forks and ignores stale child ids', () => {
  const nested = {
    title: 'Nested branches',
    current_node: 'asst-d',
    mapping: {
      root: { id: 'root', parent: null, children: ['user-1'], message: null },
      'user-1': {
        id: 'user-1',
        parent: 'root',
        children: ['asst-a', 'asst-b'],
        message: {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['Hello'] },
        },
      },
      'asst-a': {
        id: 'asst-a',
        parent: 'user-1',
        // Stale child id — ChatGPT often leaves these on inactive tips
        children: ['missing-node-id'],
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Response A'] },
        },
      },
      'asst-b': {
        id: 'asst-b',
        parent: 'user-1',
        children: ['user-2'],
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Response B'] },
        },
      },
      'user-2': {
        id: 'user-2',
        parent: 'asst-b',
        children: ['asst-c', 'asst-d'],
        message: {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['New branch from another branch'] },
        },
      },
      'asst-c': {
        id: 'asst-c',
        parent: 'user-2',
        children: [],
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Response C'] },
        },
      },
      'asst-d': {
        id: 'asst-d',
        parent: 'user-2',
        children: [],
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Response D'] },
        },
      },
    },
  };

  const branches = getAllBranches(nested);
  assert.equal(branches.length, 3);
  // Active leaf first
  assert.equal(branches[0].nodeIds.at(-1), 'asst-d');
  const texts = branches.map((b) => b.messages.at(-1)?.content?.parts?.[0]);
  assert.deepEqual(texts, ['Response D', 'Response A', 'Response C']);
});

test('getAllBranches finds forks that only share a parent pointer', () => {
  // Matches official OpenAI export shape: children null, siblings via parent only
  const forked = {
    title: 'Parent-pointer fork',
    current_node: 'asst-b',
    mapping: {
      root: { id: 'root', parent: null, children: null, message: null },
      'user-1': {
        id: 'user-1',
        parent: 'root',
        children: null,
        message: {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['Hello'] },
        },
      },
      'asst-a': {
        id: 'asst-a',
        parent: 'user-1',
        children: null,
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Response A'] },
        },
      },
      'asst-b': {
        id: 'asst-b',
        parent: 'user-1',
        children: null,
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Response B'] },
        },
      },
    },
  };

  const branches = getAllBranches(forked);
  assert.equal(branches.length, 2);
  assert.equal(branches[0].nodeIds.at(-1), 'asst-b');
  const texts = branches.map((b) => b.messages.at(-1)?.content?.parts?.[0]).sort();
  assert.deepEqual(texts, ['Response A', 'Response B']);
});

test('splitBranchesBySharedPrefix pulls the common prefix out once', () => {
  const view = splitBranchesBySharedPrefix(sampleConversation);
  // Shared prefix is the "Hello" user turn; each tail is one distinct reply
  assert.equal(view.count, 2);
  assert.deepEqual(view.shared.map((m) => m.content?.parts?.[0]), ['Hello']);
  const tails = view.branches.map((b) => b.messages.map((m) => m.content?.parts?.[0]));
  assert.deepEqual(tails, [['Response B'], ['Response A']]);
  assert.equal(view.branches[0].isActive, true);
  assert.equal(view.branches[1].isActive, false);
});

test('splitBranchesBySharedPrefix returns null for linear chats', () => {
  const linear = {
    title: 'Linear',
    current_node: 'a1',
    mapping: {
      root: { id: 'root', parent: null, children: ['u1'], message: null },
      u1: {
        id: 'u1',
        parent: 'root',
        children: ['a1'],
        message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Hi'] } },
      },
      a1: {
        id: 'a1',
        parent: 'u1',
        children: [],
        message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Yo'] } },
      },
    },
  };
  assert.equal(splitBranchesBySharedPrefix(linear), null);
});

test('linear parent-pointer chat stays one branch', () => {
  const linear = {
    title: 'Linear',
    current_node: 'asst-1',
    mapping: {
      root: { id: 'root', parent: null, children: null, message: null },
      'user-1': {
        id: 'user-1',
        parent: 'root',
        children: null,
        message: {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['Hi'] },
        },
      },
      'asst-1': {
        id: 'asst-1',
        parent: 'user-1',
        children: null,
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Hello'] },
        },
      },
    },
  };
  assert.equal(getAllBranches(linear).length, 1);
});
