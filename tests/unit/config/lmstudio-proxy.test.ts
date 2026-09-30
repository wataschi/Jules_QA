import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  countModelCall,
  getModelCallCount,
  installModelCallCounter,
  normalizeImageDataUris,
  proxyMetricsUrl,
  readProxyModelCalls,
  resetModelCallCount,
  startLmStudioProxy,
  takeModelCallCount,
} from '../../../src/config/lmstudio-proxy.js';

// Minimal real 1x1 PNG (magic bytes 89 50 4E 47).
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

describe('normalizeImageDataUris', () => {
  it('corrects a PNG mislabelled as webp using magic bytes', () => {
    const payload = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image_url', image_url: { url: `data:image/webp;base64,${PNG_B64}` } },
          ],
        },
      ],
    };
    const changed = normalizeImageDataUris(payload);
    expect(changed).toBe(true);
    expect(payload.messages[0].content[1].image_url?.url).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('leaves a correctly-labelled PNG untouched', () => {
    const payload = {
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }] },
      ],
    };
    expect(normalizeImageDataUris(payload)).toBe(false);
  });

  it('leaves payloads without images untouched', () => {
    const payload = { messages: [{ role: 'user', content: 'no image' }] };
    expect(normalizeImageDataUris(payload)).toBe(false);
  });
});

describe('startLmStudioProxy', () => {
  const servers: http.Server[] = [];

  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  it('forwards requests and rewrites webp image payloads end-to-end', async () => {
    let receivedBody = '';
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf-8');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, path: req.url }));
      });
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const proxy = await startLmStudioProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      port: 0,
    });

    try {
      const response = await fetch(`${proxy.url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: `data:image/webp;base64,${PNG_B64}` } }],
            },
          ],
        }),
      });
      const json = (await response.json()) as { ok: boolean; path: string };

      expect(json.ok).toBe(true);
      expect(json.path).toBe('/v1/chat/completions');
      expect(receivedBody).toContain(`data:image/png;base64,${PNG_B64}`);
      expect(receivedBody).not.toContain('webp');
      // thinking suppression is injected for every chat request
      expect(receivedBody).toContain('enable_thinking');
    } finally {
      await proxy.close();
    }
  });
});

describe('model call counter', () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) s.close();
    servers.length = 0;
    resetModelCallCount();
  });

  it('take resets the counter and get does not', () => {
    resetModelCallCount();
    countModelCall();
    countModelCall();
    expect(getModelCallCount()).toBe(2);
    expect(getModelCallCount()).toBe(2);
    expect(takeModelCallCount()).toBe(2);
    expect(getModelCallCount()).toBe(0);
  });

  it('counts /chat/completions requests that go through the proxy', async () => {
    const upstream = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const proxy = await startLmStudioProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      port: 0,
    });

    resetModelCallCount();
    try {
      // Не-chat запит не рахується…
      await fetch(`${proxy.url}/models`);
      expect(getModelCallCount()).toBe(0);

      // …а chat/completions — рахується.
      for (let i = 0; i < 3; i++) {
        await fetch(`${proxy.url}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [] }),
        });
      }
      expect(takeModelCallCount()).toBe(3);
      expect(getModelCallCount()).toBe(0);
    } finally {
      await proxy.close();
    }
  });
});

describe('лічильник для іншого процесу', () => {
  const saved = { ...process.env };
  const openServers: http.Server[] = [];

  afterEach(async () => {
    for (const server of openServers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    process.env.MIDSCENE_OPENAI_BASE_URL = saved.MIDSCENE_OPENAI_BASE_URL;
    process.env.MIDSCENE_VQA_BASE_URL = saved.MIDSCENE_VQA_BASE_URL;
    process.env.MIDSCENE_MODEL_BASE_URL = saved.MIDSCENE_MODEL_BASE_URL;
  });

  it('віддає лічильник по HTTP — рушій крокує в іншому процесі, ніж проксі', async () => {
    const upstream = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    openServers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const proxy = await startLmStudioProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      port: 0,
    });
    resetModelCallCount();
    process.env.MIDSCENE_OPENAI_BASE_URL = proxy.url;
    delete process.env.MIDSCENE_VQA_BASE_URL;

    try {
      expect(proxyMetricsUrl()).toBe(`${new URL(proxy.url).origin}/__jules/metrics`);
      expect(await readProxyModelCalls()).toBe(0);

      for (let i = 0; i < 2; i++) {
        await fetch(`${proxy.url}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [] }),
        });
      }

      // Саме це раніше не працювало: воркер бачив 0, бо лічильник жив в іншому процесі.
      expect(await readProxyModelCalls()).toBe(2);
    } finally {
      await proxy.close();
    }
  });

  it('без локального проксі повертає null, а не вигаданий нуль', async () => {
    process.env.MIDSCENE_OPENAI_BASE_URL = 'https://model.example.com/v1';
    delete process.env.MIDSCENE_VQA_BASE_URL;
    delete process.env.MIDSCENE_MODEL_BASE_URL;
    expect(proxyMetricsUrl()).toBeNull();
    expect(await readProxyModelCalls()).toBeNull();
  });
});

describe('installModelCallCounter', () => {
  it('counts chat/completions calls made through the global fetch', async () => {
    const upstream = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as AddressInfo).port;

    try {
      expect(installModelCallCounter()).toBe(true);
      // Повторний виклик ідемпотентний — fetch не обгортається двічі.
      expect(installModelCallCounter()).toBe(true);
      resetModelCallCount();

      await fetch(`http://127.0.0.1:${port}/v1/models`);
      expect(getModelCallCount()).toBe(0);

      await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: '{}' });
      expect(takeModelCallCount()).toBe(1);
    } finally {
      upstream.close();
    }
  });
});
