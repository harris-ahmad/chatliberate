import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectConversationsToDownload } from '../dist/index.js';

const index = [
  { id: 'a', title: 'A' },
  { id: 'b', title: 'B' },
  { id: 'c', title: 'C' },
  { id: 'd', title: 'D' },
];

const timedIndex = [
  { id: 'a', title: 'A', update_time: 100, _projectId: 'p1' },
  { id: 'b', title: 'B', update_time: 200 },
  { id: 'c', title: 'C', update_time: 300, _projectId: 'p2' },
  { id: 'd', title: 'D', update_time: 400, _projectId: 'p1' },
];

test('selectConversationsToDownload returns all when no filters', () => {
  assert.deepEqual(
    selectConversationsToDownload(index).map((c) => c.id),
    ['a', 'b', 'c', 'd'],
  );
});

test('selectConversationsToDownload skips already-saved ids (resume)', () => {
  assert.deepEqual(
    selectConversationsToDownload(index, { skipIds: ['a', 'c'] }).map((c) => c.id),
    ['b', 'd'],
  );
});

test('selectConversationsToDownload accepts a Set for skipIds', () => {
  assert.deepEqual(
    selectConversationsToDownload(index, { skipIds: new Set(['b']) }).map((c) => c.id),
    ['a', 'c', 'd'],
  );
});

test('selectConversationsToDownload restricts to conversationIds then skips', () => {
  assert.deepEqual(
    selectConversationsToDownload(index, {
      conversationIds: ['a', 'b', 'c'],
      skipIds: ['b'],
    }).map((c) => c.id),
    ['a', 'c'],
  );
});

test('selectConversationsToDownload with everything skipped returns empty', () => {
  assert.deepEqual(
    selectConversationsToDownload(index, { skipIds: ['a', 'b', 'c', 'd'] }),
    [],
  );
});

test('selectConversationsToDownload filters by projectIds', () => {
  assert.deepEqual(
    selectConversationsToDownload(timedIndex, { projectIds: ['p1'] }).map((c) => c.id),
    ['a', 'd'],
  );
});

test('selectConversationsToDownload caps at maxConversations', () => {
  assert.deepEqual(
    selectConversationsToDownload(timedIndex, { maxConversations: 2 }).map((c) => c.id),
    ['a', 'b'],
  );
});

test('selectConversationsToDownload --update: only changed or new by update_time', () => {
  const known = { a: 100, b: 150, c: 300 };
  // a unchanged (100==100) → skip; b newer (200>150) → keep; c unchanged → skip; d new → keep
  assert.deepEqual(
    selectConversationsToDownload(timedIndex, { knownUpdateTimes: known }).map((c) => c.id),
    ['b', 'd'],
  );
});

test('selectConversationsToDownload composes project + update + max in order', () => {
  const known = { a: 100 }; // a unchanged
  // projectIds p1 → [a,d]; update drops a → [d]; max 5 → [d]
  assert.deepEqual(
    selectConversationsToDownload(timedIndex, {
      projectIds: ['p1'],
      knownUpdateTimes: known,
      maxConversations: 5,
    }).map((c) => c.id),
    ['d'],
  );
});
