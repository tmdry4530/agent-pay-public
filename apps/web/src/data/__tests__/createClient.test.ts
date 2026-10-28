import { describe, expect, it } from 'vitest';
import { createClient } from '../createClient';

describe('createClient', () => {
  it('uses in-memory mock when VITE_API_BASE is empty', () => {
    const client = createClient({ VITE_API_BASE: '' } as ImportMetaEnv);
    expect(client.kind).toBe('mock');
    expect(client.reset).toBeDefined();
  });

  it('uses http client when VITE_API_BASE is set', () => {
    const client = createClient({ VITE_API_BASE: 'http://127.0.0.1:8787' } as ImportMetaEnv);
    expect(client.kind).toBe('http');
    expect(client.reset).toBeUndefined();
  });

  it('treats undefined VITE_API_BASE as mock', () => {
    const client = createClient({} as ImportMetaEnv);
    expect(client.kind).toBe('mock');
  });
});
