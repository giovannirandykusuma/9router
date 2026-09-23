import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ getProviderConnections: vi.fn(), updateProviderConnection: vi.fn(), getSettings: vi.fn(), validateApiKey: vi.fn(), getProxyPools: vi.fn() }));
vi.mock('@/lib/localDb', () => db);
vi.mock('@/lib/network/connectionProxy', () => ({ pickProxyPoolId: vi.fn(), resolveConnectionProxyConfig: vi.fn(async () => ({})) }));
vi.mock('@/shared/constants/providers.js', () => ({ FREE_PROVIDERS: {}, resolveProviderId: p => p }));
vi.mock('@/sse/utils/logger.js', () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
const { getProviderCredentials } = await import('../../src/sse/services/auth.js');
const { pickByCacheAffinity } = await import('../../src/sse/services/cacheAffinity.js');
const conns = [{ id: 'test-a', accessToken: 'synthetic-a', providerSpecificData: {} }, { id: 'test-b', accessToken: 'synthetic-b', providerSpecificData: {} }];
beforeEach(() => {
  vi.clearAllMocks();
  db.getProviderConnections.mockResolvedValue(structuredClone(conns));
  db.getSettings.mockResolvedValue({ fallbackStrategy: 'fill-first', providerStrategies: { codex: { fallbackStrategy: 'cache-affinity' } } });
});
describe('cache affinity credential selection', () => {
  it('keeps a key stable across interleaved conversations and connection ordering', async () => {
    const first = await getProviderCredentials('codex', null, 'gpt-test', { cacheKey: 'session-1' });
    await getProviderCredentials('codex', null, 'gpt-test', { cacheKey: 'session-2' });
    db.getProviderConnections.mockResolvedValue([...conns].reverse());
    expect((await getProviderCredentials('codex', null, 'gpt-test', { cacheKey: 'session-1' })).id).toBe(first.id);
  });
  it('excludes a failed preferred account without disabling fallback', async () => {
    const picked = pickByCacheAffinity('session-1', conns);
    const next = await getProviderCredentials('codex', new Set([picked.id]), 'gpt-test', { cacheKey: 'session-1' });
    expect(next.id).not.toBe(picked.id);
  });
  it('does not select model-locked accounts', async () => {
    const picked = pickByCacheAffinity('session-1', conns);
    db.getProviderConnections.mockResolvedValue(conns.map(c => ({ ...c, ...(c.id === picked.id ? { 'modelLock_gpt-test': new Date(Date.now()+60000).toISOString() } : {}) })));
    expect((await getProviderCredentials('codex', null, 'gpt-test', { cacheKey: 'session-1' })).id).not.toBe(picked.id);
  });
  it('honors an explicit available preferred connection', async () => {
    expect((await getProviderCredentials('codex', null, 'gpt-test', { cacheKey: 'session-1', preferredConnectionId: 'test-b' })).id).toBe('test-b');
  });
  it('uses fill-first when no stable key is available', async () => {
    expect((await getProviderCredentials('codex', null, 'gpt-test')).id).toBe('test-a');
  });
  it('returns null when all candidates have failed', async () => {
    expect(await getProviderCredentials('codex', new Set(['test-a', 'test-b']), 'gpt-test', { cacheKey: 'session-1' })).toBeNull();
  });
});
