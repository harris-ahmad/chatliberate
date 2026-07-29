import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAllBranches, getActivePath, countBranches } from '../dist/index.js';

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
