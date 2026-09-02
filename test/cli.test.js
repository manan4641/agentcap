'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseRun } = require('../src/cli');
const { UsageError } = require('../src/errors');
const { projectSlug } = require('../src/paths');

test('parses a cap and defaults the command to claude', () => {
  const r = parseRun(['--cap', '5.00']);
  assert.strictEqual(r.capUsd, 5);
  assert.deepStrictEqual(r.command, ['claude']);
});

test('accepts --cap=N and a leading dollar sign', () => {
  assert.strictEqual(parseRun(['--cap=2.5']).capUsd, 2.5);
  assert.strictEqual(parseRun(['--cap', '$7']).capUsd, 7);
});

test('passes the wrapped command through after --', () => {
  const r = parseRun(['--cap', '3', '--', 'claude', '--resume', '--model', 'opus']);
  assert.deepStrictEqual(r.command, ['claude', '--resume', '--model', 'opus']);
});

test('treats the first bare word as the start of the command without --', () => {
  const r = parseRun(['--cap', '3', 'claude', '--resume']);
  assert.deepStrictEqual(r.command, ['claude', '--resume']);
});

test('does not swallow the wrapped command\'s own flags', () => {
  // `--cap` after `--` belongs to the child, not to agentcap.
  const r = parseRun(['--cap', '3', '--', 'claude', '--cap', '99']);
  assert.strictEqual(r.capUsd, 3);
  assert.deepStrictEqual(r.command, ['claude', '--cap', '99']);
});

test('refuses to run without a cap', () => {
  assert.throws(() => parseRun([]), UsageError);
  assert.throws(() => parseRun(['--', 'claude']), UsageError);
});

test('rejects zero, negative, and non-numeric caps', () => {
  assert.throws(() => parseRun(['--cap', '0']), UsageError);
  assert.throws(() => parseRun(['--cap', '-1']), UsageError);
  assert.throws(() => parseRun(['--cap', 'abc']), UsageError);
  assert.throws(() => parseRun(['--cap']), UsageError);
});

test('accepts a very small cap', () => {
  assert.strictEqual(parseRun(['--cap', '0.01']).capUsd, 0.01);
});

test('derives the Claude Code project slug the same way Claude Code does', () => {
  assert.strictEqual(projectSlug('/Users/nova/Documents/AgentCap Prod'), '-Users-nova-Documents-AgentCap-Prod');
  assert.strictEqual(projectSlug('/Users/nova/Studio/luton-sixth-form-college'), '-Users-nova-Studio-luton-sixth-form-college');
});
