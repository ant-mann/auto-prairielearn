const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveOptionByToken,
  parseMultipleAnswerTokens,
  isAnswerMatch,
} = require('../content-scripts/answer-utils.js');

const OPTIONS = [
  { id: 'a', text: 'A. Red', value: 'red' },
  { id: 'b', text: 'B. Blue', value: 'blue' },
  { id: 'c', text: 'C. Green', value: 'green' },
];

test('isAnswerMatch handles punctuation and option prefixes', () => {
  assert.equal(isAnswerMatch('A. Red', 'Red'), true);
  assert.equal(isAnswerMatch('Blue.', 'Blue'), true);
  assert.equal(isAnswerMatch('C. Green', 'Green'), true);
  assert.equal(isAnswerMatch('A. Red', 'Blue'), false);
});

test('resolveOptionByToken supports strict and loose index parsing', () => {
  assert.equal(resolveOptionByToken(OPTIONS, 'B. Blue')?.id, 'b');
  assert.equal(resolveOptionByToken(OPTIONS, '2', { allowLooseIndex: true })?.id, 'b');
  assert.equal(resolveOptionByToken(OPTIONS, 'option C', { allowLooseIndex: true })?.id, 'c');
});

test('parseMultipleAnswerTokens handles JSON arrays and delimited strings', () => {
  assert.deepEqual(parseMultipleAnswerTokens('["A", "C"]', OPTIONS), {
    tokens: ['A', 'C'],
  });

  assert.deepEqual(parseMultipleAnswerTokens('A, B and C', OPTIONS), {
    tokens: ['A', 'B and C'],
  });

  assert.deepEqual(parseMultipleAnswerTokens('', OPTIONS), {
    tokens: [],
    error: 'AI response returned an empty answer.',
  });
});
