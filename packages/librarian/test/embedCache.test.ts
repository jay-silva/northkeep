import { describe, expect, it } from 'vitest';
import { createCachedEmbedder } from '../src/embedCache.js';

function counting(model = 'test-model') {
  let calls = 0;
  const inner = {
    model,
    async embed(text: string): Promise<number[]> {
      calls += 1;
      return [text.length, calls];
    },
  };
  return { inner, calls: () => calls };
}

describe('createCachedEmbedder', () => {
  it('embeds once per distinct text and returns copies', async () => {
    const { inner, calls } = counting();
    const cached = createCachedEmbedder(inner);
    const a = await cached.embed('dogs');
    const b = await cached.embed('dogs');
    expect(calls()).toBe(1);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
    b[0] = 999;
    expect(await cached.embed('dogs')).toEqual(a);
    expect(cached.size).toBe(1);
  });

  it('does not cache an empty vector', async () => {
    let calls = 0;
    const cached = createCachedEmbedder({
      model: 'm',
      async embed() {
        calls += 1;
        return [];
      },
    });
    await cached.embed('x');
    await cached.embed('x');
    expect(calls).toBe(2);
    expect(cached.size).toBe(0);
  });

  it('propagates inner failures without poisoning the cache', async () => {
    let fail = true;
    const cached = createCachedEmbedder({
      model: 'm',
      async embed() {
        if (fail) throw new Error('down');
        return [1];
      },
    });
    await expect(cached.embed('x')).rejects.toThrow('down');
    fail = false;
    expect(await cached.embed('x')).toEqual([1]);
  });

  it('evicts the least recently used entry past the bound', async () => {
    const { inner, calls } = counting();
    const cached = createCachedEmbedder(inner, 2);
    await cached.embed('a');
    await cached.embed('b');
    await cached.embed('a'); // refresh a
    await cached.embed('c'); // evicts b
    expect(cached.size).toBe(2);
    await cached.embed('a');
    expect(calls()).toBe(3);
    await cached.embed('b');
    expect(calls()).toBe(4);
  });

  it('keys by model so two models never share vectors', async () => {
    const one = counting('one');
    const cached = createCachedEmbedder(one.inner);
    await cached.embed('x');
    const two = createCachedEmbedder(counting('two').inner);
    await two.embed('x');
    expect(cached.model).toBe('one');
    expect(two.model).toBe('two');
    expect(cached.size).toBe(1);
    expect(two.size).toBe(1);
  });

  it('clear() drops everything', async () => {
    const { inner, calls } = counting();
    const cached = createCachedEmbedder(inner);
    await cached.embed('x');
    cached.clear();
    expect(cached.size).toBe(0);
    await cached.embed('x');
    expect(calls()).toBe(2);
  });
});
