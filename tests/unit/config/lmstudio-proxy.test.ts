import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeImageDataUris, startLmStudioProxy } from '../../../src/config/lmstudio-proxy.js';

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
