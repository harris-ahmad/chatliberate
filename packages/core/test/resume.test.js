import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectConversationsToDownload } from '../dist/index.js';

const index = [
  { id: 'a', title: 'A' },
  { id: 'b', title: 'B' },
  { id: 'c', title: 'C' },
  { id: 'd', title: 'D' },
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
