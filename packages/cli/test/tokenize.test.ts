import { describe, expect, it } from 'vitest';
import { tokenizeCommand } from '../src/tokenize.js';

describe('tokenizeCommand', () => {
  it('splits bare words on whitespace', () => {
    expect(tokenizeCommand('remember hello there')).toEqual(['remember', 'hello', 'there']);
  });

  it('collapses runs of whitespace (spaces and tabs)', () => {
    expect(tokenizeCommand('list   \t  memories')).toEqual(['list', 'memories']);
  });

  it('preserves spaces inside double quotes', () => {
    expect(tokenizeCommand('remember "buy milk"')).toEqual(['remember', 'buy milk']);
  });

  it('preserves spaces inside single quotes', () => {
    expect(tokenizeCommand("remember 'buy milk' --scope home")).toEqual([
      'remember',
      'buy milk',
      '--scope',
      'home',
    ]);
  });

  it('lets each quote type appear literally inside the other', () => {
    expect(tokenizeCommand(`remember "it's mine"`)).toEqual(['remember', "it's mine"]);
    expect(tokenizeCommand(`remember 'say "hi"'`)).toEqual(['remember', 'say "hi"']);
  });

  it('joins adjacent quoted and bare runs into one token', () => {
    expect(tokenizeCommand('foo" bar"baz')).toEqual(['foo barbaz']);
  });

  it('keeps an empty quoted string as a token', () => {
    expect(tokenizeCommand('remember ""')).toEqual(['remember', '']);
  });

  it('returns [] for empty or whitespace-only input', () => {
    expect(tokenizeCommand('')).toEqual([]);
    expect(tokenizeCommand('    ')).toEqual([]);
  });
});
