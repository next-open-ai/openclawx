import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPACTION_CHAR_THRESHOLD,
  COMPACTION_WINDOW_RATIO,
  SESSION_SUMMARY_PREFIX,
  sessionSummaryMessagePair,
} from '../context-compaction.js';
import { formatAnchorsBlock, type ContextAnchors } from '../context-sanitize.js';

test('compaction thresholds are defined for mid-run hygiene pipeline', () => {
  assert.ok(COMPACTION_CHAR_THRESHOLD >= 48_000);
  assert.ok(COMPACTION_WINDOW_RATIO > 0.5 && COMPACTION_WINDOW_RATIO < 0.95);
});

test('session summary pair keeps OpenClawX prefix for re-injection', () => {
  const pair = sessionSummaryMessagePair('Goal: ship index.html\nPaths: output/index.html');
  assert.equal(pair.length, 2);
  assert.ok(pair[0]!.content.startsWith(SESSION_SUMMARY_PREFIX));
  assert.match(pair[0]!.content, /output\/index\.html/);
});

test('anchors block is stable for summary merge', () => {
  const anchors: ContextAnchors = {
    goal: 'build duck game',
    writtenPaths: ['output/index.html', 'output/README.md'],
    errors: ['write_workspace_file: JSON parse failed'],
  };
  const block = formatAnchorsBlock(anchors);
  assert.match(block, /goal:\nbuild duck game/);
  assert.match(block, /writtenPaths: output\/index\.html, output\/README\.md/);
  assert.match(block, /JSON parse failed/);
});
