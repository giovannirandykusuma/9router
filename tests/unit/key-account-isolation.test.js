import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ getProviderConnections: vi.fn(), updateProviderConnection: vi.fn(), getSettings: vi.fn(), validateApiKey: vi.fn(), getProxyPools: vi.fn() }));
vi.mock('@/lib/localDb', () => db);
vi.mock('@/lib/network/connectionProxy', () => ({ pickProxyPoolId: vi.fn(), resolveConnectionProxyConfig: vi.fn(async () => ({})) }));
vi.mock('@/lib/db/repos/apiKeysRepo.js', () => ({ getApiKeyByKey: vi.fn() }));
vi.mock('@/lib/db/repos/combosRepo.js', () => ({ getCombos: vi.fn(async () => []) }));
vi.mock('@/sse/services/model.js', () => ({ getComboModels: vi.fn(async () => null), getModelInfo: vi.fn(async (s) => { const [provider, model] = s.split('/'); return { provider, model }; }) }));
vi.mock('@/sse/utils/logger.js', () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
const { getProviderCredentials } = await import('../../src/sse/services/auth.js');
const access = await import('../../src/sse/services/keyAccess.js');
const helpers = await import('../../src/shared/utils/keyAccess.js');
const accounts = [{ id: 'king', accessToken: 'synthetic-a', providerSpecificData: {} }, { id: 'private', accessToken: 'synthetic-b', providerSpecificData: {} }];
const ctx = () => ({ keyName: 'kenny', allow: [], allowedProviders: ['codex'], allowedConnections: ['king'] });
beforeEach(() => {
  vi.clearAllMocks();
  db.getProviderConnections.mockResolvedValue(structuredClone(accounts));
  db.getSettings.mockResolvedValue({ fallbackStrategy: 'fill-first' });
});
describe('provider/account key isolation', () => {
  it.each(['fill-first', 'round-robin', 'cache-affinity'])('restricts %s selection even with a private preferred account', async (strategy) => {
    db.getSettings.mockResolvedValue({ fallbackStrategy: strategy });
    const allowedConnectionIds = await access.getAllowedConnectionIdsForProvider(ctx(), 'cx');
    const cred = await getProviderCredentials('codex', null, 'gpt-test', { allowedConnectionIds, preferredConnectionId: 'private', cacheKey: 'private-session' });
    expect(cred.connectionId).toBe('king');
  });
  it('never borrows after the selected account fails', async () => {
    const allowedConnectionIds = await access.getAllowedConnectionIdsForProvider(ctx(), 'codex');
    expect(await getProviderCredentials('codex', new Set(['king']), 'gpt-test', { allowedConnectionIds })).toBeNull();
  });
  it('never borrows when selected account is rate limited', async () => {
    db.getProviderConnections.mockResolvedValue(accounts.map(c => c.id === 'king' ? { ...c, 'modelLock_gpt-test': new Date(Date.now() + 60000).toISOString() } : c));
    const cred = await getProviderCredentials('codex', null, 'gpt-test', { allowedConnectionIds: new Set(['king']) });
    expect(cred.allRateLimited).toBe(true);
    expect(cred.connectionId).toBeUndefined();
  });
  it('deletion or deactivation retains the saved ID and denies rather than widening', async () => {
    db.getProviderConnections.mockResolvedValue([accounts[1]]);
    const allowedConnectionIds = await access.getAllowedConnectionIdsForProvider(ctx(), 'codex');
    expect([...allowedConnectionIds]).toEqual(['king']);
    expect(await getProviderCredentials('codex', null, 'gpt-test', { allowedConnectionIds })).toBeNull();
  });
  it('denies a different provider before querying credentials', async () => {
    const allowedConnectionIds = await access.getAllowedConnectionIdsForProvider(ctx(), 'openai');
    expect(await getProviderCredentials('openai', null, 'gpt-test', { allowedConnectionIds })).toBeNull();
    expect(db.getProviderConnections).not.toHaveBeenCalled();
  });
  it('does not ignore account restrictions for virtual no-auth providers', async () => {
    const { FREE_PROVIDERS } = await import('../../src/shared/constants/providers.js');
    const provider = Object.keys(FREE_PROVIDERS).find(p => FREE_PROVIDERS[p].noAuth);
    expect(provider).toBeTruthy();
    expect(await getProviderCredentials(provider, null, 'test', { allowedConnectionIds: new Set(['king']) })).toBeNull();
  });
  it('provider-only grants support aliases including OpenCode Go', async () => {
    expect(await access.enforceKeyAccessResolved({ ...ctx(), allowedProviders: ['ocg'], allowedConnections: [] }, 'ocg/test', 'opencode-go', 'test')).toBeNull();
    expect(await access.enforceKeyAccessResolved(ctx(), 'cx/test', 'codex', 'test')).toBeNull();
    expect((await access.enforceKeyAccessResolved(ctx(), 'openai/test', 'openai', 'test')).status).toBe(403);
  });
  it('existing model restrictions remain an intersection', async () => {
    expect((await access.enforceKeyAccessResolved({ ...ctx(), allow: ['codex/allowed'] }, 'codex/other', 'codex', 'other')).status).toBe(403);
  });
  it('combo pruning removes disallowed providers without granting direct member access', async () => {
    expect(await access.pruneComboModelsForKey(ctx(), ['codex/test', 'openai/test'], 'shared')).toEqual(['codex/test']);
    expect(await access.pruneComboModelsForKey({ ...ctx(), allowedProviders: ['tavily'] }, ['tavily', 'brave'], 'search', true)).toEqual(['tavily']);
  });
  it('account-only grants still intersect each provider connection set', async () => {
    const allowedConnectionIds = await access.getAllowedConnectionIdsForProvider({ ...ctx(), allowedProviders: [] }, 'openai');
    db.getProviderConnections.mockResolvedValue([accounts[1]]);
    expect(await getProviderCredentials('openai', null, 'test', { allowedConnectionIds })).toBeNull();
  });
});
describe('scope persistence', () => {
  it('round trips all scopes', () => {
    const policy = { restricted: true, allow: [], allowedProviders: ['codex'], allowedConnections: ['king'] };
    const cols = helpers.keyAccessToColumns(policy);
    expect(helpers.keyAccessFromColumns(cols.accessRestricted, cols.accessAllow)).toEqual(policy);
  });
  it.each([{ allow: [], allowedProviders: ['codex'], allowedConnections: 'king' }, { allow: 'broken', allowedProviders: ['codex'] }, { allow: [], allowedConnections: [42] }])('corrupt object scopes fail closed: %j', (policy) => {
    expect(helpers.keyAccessFromColumns(1, JSON.stringify(policy))).toEqual({ restricted: true, allow: [] });
  });
  it('rejects malformed API scopes', () => {
    expect(helpers.validateKeyAccessInput({ restricted: true, allowedConnections: 'king' }).ok).toBe(false);
    expect(helpers.validateKeyAccessInput({ restricted: true, allowedProviders: [42] }).ok).toBe(false);
  });
});
