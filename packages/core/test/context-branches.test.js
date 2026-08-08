import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toContextBlock } from '../dist/index.js';

const branchedConversation = {
  title: 'Branch copy test',
  current_node: 'asst-b',
  conversation_id: 'abc-123',
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

test('toContextBlock defaults to active path only', () => {
  const block = toContextBlock([branchedConversation]);
  assert.match(block, /Response B/);
  assert.doesNotMatch(block, /Response A/);
  assert.doesNotMatch(block, /Branch 1/);
  assert.doesNotMatch(block, /regenerated branches/);
});

test('toContextBlock includeAllBranches preserves every regenerated reply', () => {
  const block = toContextBlock([branchedConversation], { includeAllBranches: true });
  assert.match(block, /2 regenerated branches preserved/);
  assert.match(block, /#### Branch 1 \(active\)/);
  assert.match(block, /#### Branch 2/);
  assert.match(block, /Response A/);
  assert.match(block, /Response B/);
});

test('toContextBlock renders shared history once, not per branch', () => {
  const block = toContextBlock([branchedConversation], { includeAllBranches: true });
  // "Hello" is the shared user turn before the fork — must appear exactly once
  const helloCount = (block.match(/Hello/g) || []).length;
  assert.equal(helloCount, 1);
  assert.match(block, /#### Shared history/);
});

test('toContextBlock splits ChatGPT “Branch in new chat” linear forks', () => {
  const linearFork = {
    title: 'Branch · SEO for React Apps',
    current_node: 'a2',
    conversation_id: 'fork-1',
    mapping: {
      root: { id: 'root', parent: null, children: ['u1'], message: null },
      u1: {
        id: 'u1',
        parent: 'root',
        children: ['a1'],
        message: {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['SEO question'] },
        },
      },
      a1: {
        id: 'a1',
        parent: 'u1',
        children: ['u2'],
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Hey! What\'s up?'] },
        },
      },
      u2: {
        id: 'u2',
        parent: 'a1',
        children: ['a2'],
        message: {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['this is a new branch from another branch'] },
        },
      },
      a2: {
        id: 'a2',
        parent: 'u2',
        children: [],
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Yep. If you create a branch…'] },
        },
      },
    },
  };

  const block = toContextBlock([linearFork], {
    includeAllBranches: true,
    chatBranch: {
      label: 'Branched from Branch · SEO for React Apps',
      firstUserText: 'this is a new branch from another branch',
    },
  });

  assert.match(block, /#### Shared history \(before branch\)/);
  assert.match(block, /#### Branched from Branch · SEO for React Apps/);
  assert.match(block, /SEO question/);
  assert.match(block, /this is a new branch from another branch/);
});
