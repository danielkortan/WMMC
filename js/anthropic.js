// ============================================================
// WMMC — Anthropic API response shape (pure)
// ============================================================
// Reading the text out of a Messages API reply, correctly.
//
// This exists because getting it wrong is silent and expensive. Every caller in this app used
// `data.content[0].text`, which assumes the first content block is the answer. It often is —
// and then one day it is not: a model that emits a `thinking` block puts that at index 0, and
// `content[0].text` is `undefined`. The call succeeded, HTTP 200, tokens billed, and the app
// quietly fell back to its static template bank. Three separate features (the daily Hot Takes,
// the elimination roasts, the season-opening draft roast) did that for months, and the
// conclusion recorded at the time was "production must have no ANTHROPIC_API_KEY" — it had
// one, and it worked.
//
// So: never index into `content`. Walk it, take every text block, join them.

// The assistant's text from a Messages API response, or '' when there is none.
// Tolerates any shape — missing content, non-arrays, blocks with no text, thinking blocks,
// tool_use blocks — because the whole point is to not assume.
export function anthropicReplyText(data) {
  const blocks = data && Array.isArray(data.content) ? data.content : [];
  return blocks
    .filter((b) => b && (b.type === 'text' || (b.type === undefined && typeof b.text === 'string')))
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('')
    .trim();
}

// A short description of what actually came back, for the log line when `anthropicReplyText`
// returns nothing. Without this an empty reply is unattributable: "the API returned an empty
// reply" is true of a refusal, a `max_tokens` cut-off mid-thinking, and a response made
// entirely of tool blocks, and those want very different fixes.
export function describeAnthropicReply(data) {
  const blocks = data && Array.isArray(data.content) ? data.content : null;
  if (!blocks) return 'no content array in the response';
  if (blocks.length === 0) return 'content array was empty';
  const types = blocks.map((b) => (b && b.type) || 'untyped').join(', ');
  const stop = data.stop_reason ? `, stop_reason: ${data.stop_reason}` : '';
  const usage =
    data.usage && (data.usage.output_tokens != null || data.usage.input_tokens != null)
      ? `, tokens in/out: ${data.usage.input_tokens ?? '?'}/${data.usage.output_tokens ?? '?'}`
      : '';
  return `content blocks: [${types}]${stop}${usage}`;
}
