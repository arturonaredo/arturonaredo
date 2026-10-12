/* Dependency-free regression tests; use only the already-public snapshot. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateSnapshot, levelFor, isoAddDays } = require('../site/calendar.js');
const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/profile/snapshot.json'), 'utf8'));
const clone = () => structuredClone(snapshot);
const valid = (value) => validateSnapshot(value, snapshot.aggregate_date) === null;

test('published reduced snapshot is accepted without changing any data', () => {
  const value = clone();
  assert.ok(valid(value));
  assert.deepEqual(value, snapshot);
});

for (const [name, mutate] of [
  ['negative', (s) => { s.token_calendar.days[0].tokens = -1; }],
  ['boolean', (s) => { s.token_calendar.days[0].tokens = true; }],
  ['fractional', (s) => { s.token_calendar.days[0].tokens = 0.5; }],
  ['unsafe integer', (s) => { s.token_calendar.days[0].tokens = Number.MAX_SAFE_INTEGER + 1; }],
  ['null with level', (s) => { s.token_calendar.days[0].tokens = null; s.token_calendar.days[0].level = 1; }],
  ['zero with missing level', (s) => { s.token_calendar.days[0].tokens = 0; s.token_calendar.days[0].level = null; }],
  ['wrong band', (s) => { const d = s.token_calendar.days.find(d => d.tokens !== null); d.level = (d.level + 1) % 5; }],
  ['duplicate date', (s) => { s.token_calendar.days[1].date = s.token_calendar.days[0].date; }],
  ['skipped first day', (s) => { for (const d of s.token_calendar.days) d.date = isoAddDays(d.date, 1); }],
  ['invalid calendar date', (s) => { s.token_calendar.days[0].date = '2026-02-30'; }],
  ['invalid aggregate date', (s) => { s.aggregate_date = '2026-02-30'; }],
  ['missing day', (s) => { s.token_calendar.days.pop(); }],
  ['foreign source', (s) => { s.token_calendar.source = 'litellm'; }],
  ['foreign provider scope', (s) => { s.token_calendar.provider = 'OpenAI'; }],
  ['historical calendar', (s) => { s.token_calendar_history = [{}]; }],
  ['historical diagnostics', (s) => { s.coverage = [{}]; }],
  ['tracking date', (s) => { s.tracking_since = '2025-01-01'; }],
  ['wrong unit', (s) => { s.metrics.opencode_tokens_year.unit = 'count'; }],
  ['null metric', (s) => { s.metrics.opencode_cached_tokens_year = null; }],
  ['wrong quality', (s) => { s.metrics.opencode_tokens_year.quality = 'unavailable'; }],
  ['broken decomposition', (s) => { s.metrics.opencode_tokens_year.value++; }],
  ['cutoff drift', (s) => { s.token_calendar.period_end = isoAddDays(s.token_calendar.period_end, 7); }],
  ['future aggregate', (s) => { s.aggregate_date = isoAddDays(s.aggregate_date, 1); }],
  ['insufficient qualified days', (s) => {
    let kept = 0;
    for (const d of s.token_calendar.days) {
      if (d.tokens !== null && ++kept > 6) { d.tokens = null; d.level = null; }
    }
  }],
]) {
  test(`rejects ${name}`, () => {
    const value = clone(); mutate(value); assert.ok(!valid(value));
  });
}

test('leap-year dates are complete and observed zero remains zero', () => {
  const s = clone();
  s.aggregate_date = '2024-10-14'; s.period_end = '2024-10-07'; s.period_start = '2024-09-07';
  s.token_calendar.period_start = '2024-01-01'; s.token_calendar.period_end = s.period_end;
  s.token_calendar.days = [];
  for (let date = '2024-01-01'; date < s.period_end; date = isoAddDays(date, 1)) {
    s.token_calendar.days.push({ date, tokens: 0, level: 0 });
  }
  for (const key of ['opencode_tokens_year', 'opencode_fresh_input_tokens_year', 'opencode_cached_tokens_year', 'opencode_output_tokens_year']) {
    s.metrics[key].value = 0;
  }
  assert.equal(validateSnapshot(s, '2024-10-14'), null);
  assert.ok(s.token_calendar.days.some(d => d.date === '2024-02-29'));
  assert.equal(isoAddDays('2024-02-28', 1), '2024-02-29');
  assert.equal(levelFor(0), 0);
  assert.deepEqual([1, 1000000, 10000000, 100000000].map(levelFor), [1, 2, 3, 4]);
});
