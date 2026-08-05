import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExportIndexMarkdown,
  markdownExportPath,
  slugifySegment,
  toMarkdownExportLayout,
} from '../dist/index.js';

test('slugifySegment cleans project names', () => {
  assert.equal(slugifySegment('My Cool Project!'), 'my-cool-project');
  assert.equal(slugifySegment('@@@'), 'untitled');
});

test('markdownExportPath puts project chats under projects/', () => {
  const conv = {
    title: 'Hello',
    conversation_id: 'abcdef12-3456',
    create_time: 1700000000,
    _projectName: 'Work Stuff',
  };
  const info = markdownExportPath(conv);
  assert.match(info.path, /^markdown\/projects\/work-stuff\//);
  assert.equal(info.filesRelPath, '../../files');
  assert.equal(info.projectName, 'Work Stuff');
});

test('markdownExportPath puts archived chats under archived/', () => {
  const conv = {
    title: 'Old',
    conversation_id: 'deadbeef-0000',
    create_time: 1700000000,
    is_archived: true,
  };
  const info = markdownExportPath(conv);
  assert.match(info.path, /^markdown\/archived\//);
  assert.equal(info.filesRelPath, '../../files');
});

test('buildExportIndexMarkdown groups projects and links paths', () => {
  const md = buildExportIndexMarkdown(
    [
      {
        title: 'Proj chat',
        id: '11111111',
        path: 'markdown/projects/alpha/2024-01-01 proj-chat 11111111.md',
        updateTime: 1700000000,
        projectName: 'Alpha',
      },
      {
        title: 'Inbox chat',
        id: '22222222',
        path: 'markdown/2024-01-02 inbox-chat 22222222.md',
        updateTime: 1700001000,
      },
    ],
    { exportedAt: '2026-08-01T00:00:00.000Z', conversationCount: 2, projectCount: 1 },
  );

  assert.match(md, /# ChatLiberate Export Index/);
  assert.match(md, /## Projects/);
  assert.match(md, /### Alpha/);
  assert.match(md, /\[Proj chat\]\(markdown\/projects\/alpha\//);
  assert.match(md, /## Chats/);
  assert.match(md, /\[Inbox chat\]\(markdown\//);
});

test('toMarkdownExportLayout writes nested paths and INDEX', () => {
  const layout = toMarkdownExportLayout([
    {
      title: 'In project',
      conversation_id: 'aaaaaaaa-bbbb',
      create_time: 1700000000,
      update_time: 1700000000,
      _projectName: 'Beta',
      mapping: {
        root: { id: 'root', parent: null, children: ['u'], message: null },
        u: {
          id: 'u',
          parent: 'root',
          children: [],
          message: {
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['hi'] },
          },
        },
      },
      current_node: 'u',
    },
  ]);

  assert.equal(layout.files.size, 1);
  const [path, md] = [...layout.files.entries()][0];
  assert.match(path, /^markdown\/projects\/beta\//);
  assert.match(md, /project: "Beta"/);
  assert.match(layout.indexMarkdown, /### Beta/);
});
