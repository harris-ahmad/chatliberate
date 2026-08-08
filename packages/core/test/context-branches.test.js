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

test('toContextBlock truncates an oversized chat to its tail instead of dropping it', () => {
  const big = {
    title: 'Long chat',
    current_node: 'aN',
    mapping: {
      root: { id: 'root', parent: null, children: ['u1'], message: null },
    },
  };
  // Build a long linear chain: u1 -> a1 -> u2 -> a2 ... with bulky bodies
  let prev = 'root';
  for (let i = 1; i <= 40; i++) {
    const u = `u${i}`;
    const a = `a${i}`;
    big.mapping[u] = {
      id: u, parent: prev, children: [a],
      message: { author: { role: 'user' }, content: { content_type: 'text', parts: [`Question ${i} ` + 'x'.repeat(200)] } },
    };
    big.mapping[a] = {
      id: a, parent: u, children: i === 40 ? [] : [`u${i + 1}`],
      message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: [`Answer ${i} ` + 'y'.repeat(200)] } },
    };
    prev = a;
  }
  big.current_node = 'a40';

  const block = toContextBlock([big], { maxChars: 4000 });
  // Must not be empty (the bug), must carry the marker, and must keep the most recent turn
  assert.ok(block.length > 500);
  assert.match(block, /Older messages truncated/);
  assert.match(block, /Answer 40/);
  // Oldest turns are dropped
  assert.doesNotMatch(block, /Question 1 /);
  assert.ok(block.length <= 4000);
});

test('toContextBlock honors the branched-from divider even with regen branches', () => {
  // Shared history (u1/a1/u2) contains a "branched from" turn (u2), then the
  // last assistant reply is regenerated into two branches (a3a/a3b).
  const forkWithRegens = {
    title: 'Fork + regens',
    current_node: 'a3b',
    conversation_id: 'mix-1',
    mapping: {
      root: { id: 'root', parent: null, children: ['u1'], message: null },
      u1: { id: 'u1', parent: 'root', children: ['a1'], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Original question'] } } },
      a1: { id: 'a1', parent: 'u1', children: ['u2'], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Original answer'] } } },
      u2: { id: 'u2', parent: 'a1', children: ['a3a', 'a3b'], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['this is a new branch from another branch'] } } },
      a3a: { id: 'a3a', parent: 'u2', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Regen reply A'] } } },
      a3b: { id: 'a3b', parent: 'u2', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Regen reply B'] } } },
    },
  };

  const block = toContextBlock([forkWithRegens], {
    includeAllBranches: true,
    chatBranch: {
      label: 'Branched from Branch · Something',
      firstUserText: 'this is a new branch from another branch',
    },
  });

  // Regen branches still preserved…
  assert.match(block, /2 regenerated branches preserved/);
  assert.match(block, /#### Branch 1 \(active\)/);
  assert.match(block, /Regen reply A/);
  assert.match(block, /Regen reply B/);
  // …and the branched-from split is applied to the shared history (not dropped)
  assert.match(block, /#### Shared history \(before branch\)/);
  assert.match(block, /#### Branched from Branch · Something/);
  assert.match(block, /Original question/);
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
