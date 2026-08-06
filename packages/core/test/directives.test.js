import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMessageText, stripDirectiveMarkup } from '../dist/index.js';

test('stripDirectiveMarkup removes writing container fences', () => {
  const raw = [
    ':::writing{variant="chat_message" id="47081"}',
    "Yeah, that's a common issue with client-side rendered React apps.",
    '',
    'The best solution is to use server-side rendering (SSR).',
    ':::',
  ].join('\n');

  const cleaned = stripDirectiveMarkup(raw);
  assert.ok(!cleaned.includes(':::'));
  assert.match(cleaned, /client-side rendered React apps/);
  assert.match(cleaned, /server-side rendering \(SSR\)/);
});

test('stripDirectiveMarkup leaves code fences and their contents alone', () => {
  const raw = ['```js', 'const a = ":::not a directive";', '```'].join('\n');
  assert.equal(stripDirectiveMarkup(raw), raw);
});

test('stripDirectiveMarkup keeps inline colons untouched', () => {
  const raw = 'Use the ::: syntax when writing directives inline.';
  assert.equal(stripDirectiveMarkup(raw), raw);
});

test('extractMessageText strips directives and drops duplicate blocks', () => {
  const block = [
    ':::writing{variant="chat_message" id="47081"}',
    'Google renders JavaScript in a second wave.',
    ':::',
  ].join('\n');

  const text = extractMessageText({
    author: { role: 'assistant' },
    content: { content_type: 'text', parts: [block, block] },
  });

  assert.equal(text, 'Google renders JavaScript in a second wave.');
});
