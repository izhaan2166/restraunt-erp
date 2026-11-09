import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, errorMessage, getAccessToken, request, setAccessToken, setFetch } from './api';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => setAccessToken(null));

describe('request', () => {
  it('sends the token, the idempotency key and a JSON body', async () => {
    const f = vi.fn(async () => json(201, { data: { id: 'o1' } }));
    setFetch(f as unknown as typeof fetch);
    setAccessToken('t1');
    const r = await api.post<{ id: string }>('/orders', { a: 1 }, 'key-1');
    expect(r).toEqual({ id: 'o1' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/orders');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer t1', 'Idempotency-Key': 'key-1' });
  });

  it('drops empty query values', async () => {
    const f = vi.fn(async () => json(200, { data: [] }));
    setFetch(f as unknown as typeof fetch);
    await api.get('/kot', { branchId: 'b1', stationId: undefined, status: '' });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('/api/v1/kot?branchId=b1');
  });

  it('refreshes once on 401 and retries with the new token; parallel 401s share one refresh', async () => {
    let refreshes = 0;
    const f = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/refresh')) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { data: { accessToken: 'fresh' } });
      }
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === 'Bearer fresh' ? json(200, { data: 'ok' }) : json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } });
    });
    setFetch(f as unknown as typeof fetch);
    setAccessToken('stale');
    const results = await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);
    expect(results).toEqual(['ok', 'ok', 'ok']);
    expect(refreshes).toBe(1);
    expect(getAccessToken()).toBe('fresh');
  });

  it('signs out (clears the token) when the refresh is refused', async () => {
    setFetch((async (url: string) =>
      url.endsWith('/auth/refresh') ? json(401, { error: { code: 'UNAUTHENTICATED', message: 'no' } }) : json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } })) as unknown as typeof fetch);
    setAccessToken('stale');
    await expect(api.get('/x')).rejects.toMatchObject({ status: 401 });
    expect(getAccessToken()).toBeNull();
  });

  it('turns API errors into ApiError with code, details and request id', async () => {
    setFetch((async () => json(409, { error: { code: 'CONCURRENT_UPDATE', message: 'stale', details: { version: 3 }, requestId: 'abcdef1234' } })) as unknown as typeof fetch);
    const err = await request('/orders/1', { method: 'PATCH', body: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'CONCURRENT_UPDATE', details: { version: 3 }, requestId: 'abcdef1234' });
    expect(errorMessage(err)).toMatch(/changed on another device/);
  });

  it('reports a network failure plainly', async () => {
    setFetch((async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    const err = await api.get('/x').catch((e) => e);
    expect(err).toMatchObject({ code: 'NETWORK' });
  });
});

describe('errorMessage', () => {
  it('adds a reference for server faults only', () => {
    expect(errorMessage(new ApiError(500, 'INTERNAL', 'Something broke', undefined, '1234567890'))).toBe('Something broke (reference 12345678)');
    expect(errorMessage(new ApiError(422, 'ORDER_EMPTY', 'The order has no items to bill', undefined, '1234567890'))).toBe('The order has no items to bill');
    expect(errorMessage(new Error('x'))).toBe('Something went wrong. Please try again.');
  });
});
