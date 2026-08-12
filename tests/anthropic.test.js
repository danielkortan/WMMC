import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicReplyText, describeAnthropicReply } from '../js/anthropic.js';

describe('anthropicReplyText', () => {
  it('reads a plain single-block reply', () => {
    assert.equal(anthropicReplyText({ content: [{ type: 'text', text: 'hello' }] }), 'hello');
  });

  it('skips a leading thinking block — the bug this module exists for', () => {
    const data = {
      content: [
        { type: 'thinking', thinking: 'let me consider the matchups...' },
        { type: 'text', text: ':boom: Ryan S. went off for 55.7' },
      ],
    };
    assert.equal(anthropicReplyText(data), ':boom: Ryan S. went off for 55.7');
    // The old `content[0].text` would have produced undefined here.
    assert.equal(data.content[0].text, undefined);
  });

  it('joins multiple text blocks in order', () => {
    const data = {
      content: [
        { type: 'text', text: 'one\n' },
        { type: 'text', text: 'two' },
      ],
    };
    assert.equal(anthropicReplyText(data), 'one\ntwo');
  });

  it('ignores tool_use and other non-text blocks', () => {
    const data = {
      content: [
        { type: 'tool_use', id: 't1', name: 'x', input: {} },
        { type: 'text', text: 'the answer' },
        { type: 'redacted_thinking', data: '...' },
      ],
    };
    assert.equal(anthropicReplyText(data), 'the answer');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(anthropicReplyText({ content: [{ type: 'text', text: '\n  padded  \n' }] }), 'padded');
  });

  it('returns empty string for every shape of nothing', () => {
    assert.equal(anthropicReplyText(null), '');
    assert.equal(anthropicReplyText(undefined), '');
    assert.equal(anthropicReplyText({}), '');
    assert.equal(anthropicReplyText({ content: [] }), '');
    assert.equal(anthropicReplyText({ content: 'not an array' }), '');
    assert.equal(anthropicReplyText({ content: [null, undefined] }), '');
    assert.equal(anthropicReplyText({ content: [{ type: 'thinking', thinking: 'only thinking' }] }), '');
    assert.equal(anthropicReplyText({ content: [{ type: 'text' }] }), '');
  });

  it('accepts an untyped block that carries text, for older response shapes', () => {
    assert.equal(anthropicReplyText({ content: [{ text: 'legacy' }] }), 'legacy');
  });
});

describe('describeAnthropicReply', () => {
  it('names the block types so an empty reply is attributable', () => {
    const d = describeAnthropicReply({ content: [{ type: 'thinking' }], stop_reason: 'max_tokens' });
    assert.match(d, /content blocks: \[thinking\]/);
    assert.match(d, /stop_reason: max_tokens/);
  });

  it('includes token usage when present', () => {
    const d = describeAnthropicReply({
      content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 1200, output_tokens: 0 },
    });
    assert.match(d, /tokens in\/out: 1200\/0/);
  });

  it('distinguishes an empty array from a missing one', () => {
    assert.equal(describeAnthropicReply({ content: [] }), 'content array was empty');
    assert.equal(describeAnthropicReply({}), 'no content array in the response');
    assert.equal(describeAnthropicReply(null), 'no content array in the response');
  });

  it('labels a block with no type rather than throwing', () => {
    assert.match(describeAnthropicReply({ content: [{}, null] }), /\[untyped, untyped\]/);
  });
});
