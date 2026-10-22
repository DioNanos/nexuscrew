import { describe, expect, it } from 'vitest';
import {
  CELL, FIXTURE_BUILDERS, NODE, OWNER, REVIEWS, TARGETS,
} from './chat-fixtures.js';

const APPROVAL_SUMMARY_KEYS = [
  'approvalId', 'commandHash', 'coverage', 'epoch', 'remainingMs', 'reviewAvailable', 'ruleIds',
];

function frames() {
  return Object.entries(FIXTURE_BUILDERS).flatMap(([name, build]) => build().map((frame) => ({ name, frame })));
}

describe('fixture identities are synthetic', () => {
  it('never reuses the live fleet owner, node or cell', () => {
    expect(OWNER).toBe('0'.repeat(32));
    expect(NODE).toBe('1'.repeat(32));
    expect(CELL).toBe('ui0-demo-cell');
    expect(TARGETS.vl.ref).toBe(`${OWNER}:VL-${NODE}`);
    expect(TARGETS.cli.ref).toBe(`${OWNER}:cell-${CELL}`);
    for (const target of Object.values(TARGETS)) {
      expect(target.ref).not.toContain('82dffb30');
      expect(target.ref).not.toContain('36b876f2');
    }
  });
});

describe('fixture frames follow nc-chat/1', () => {
  it('keeps target, source kind, boot, generation and seq', () => {
    for (const { name, frame } of frames()) {
      if (frame.type !== 'event' && frame.type !== 'gap' && frame.type !== 'reset') continue;
      const target = frame.target;
      expect(target, name).toBeTruthy();
      expect(Object.values(TARGETS).map((t) => t.ref), name).toContain(target.ref);
      if (frame.type !== 'event') continue; // control frames carry no event source
      const { source } = frame.event;
      expect(['vl_host', 'cli_adapter'], name).toContain(source.kind);
      expect(typeof source.bootId, name).toBe('string');
      expect(Number.isInteger(source.generation), name).toBe(true);
      expect(Number.isInteger(source.seq) && source.seq >= 0, name).toBe(true);
    }
  });

  it('puts toolCallId on the event, never duplicated inside data', () => {
    for (const { name, frame } of frames()) {
      if (frame.type !== 'event') continue;
      const { type, toolCallId, data } = frame.event;
      if (type !== 'tool_start' && type !== 'tool_end') continue;
      expect(typeof toolCallId, name).toBe('string');
      expect(toolCallId.length, name).toBeGreaterThan(0);
      expect(data.toolCallId, name).toBeUndefined();
    }
  });

  it('keeps only the approval summary in the event ring', () => {
    for (const { name, frame } of frames()) {
      if (frame.type !== 'event' || frame.event.type !== 'approval_requested') continue;
      expect(Object.keys(frame.event.data).sort(), name).toEqual(APPROVAL_SUMMARY_KEYS);
      expect(frame.event.data.review, name).toBeUndefined();
      expect(frame.event.data.displayCommand, name).toBeUndefined();
    }
  });

  it('keeps the reserved review in its own map', () => {
    for (const review of Object.values(REVIEWS)) {
      expect(typeof review.displayCommand).toBe('string');
      expect(typeof review.complete).toBe('boolean');
    }
  });
});
