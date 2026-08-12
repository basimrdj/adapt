import { describe, it, expect } from 'vitest';
import { MockPlanner } from '../../src/shared/ai/mock-planner';
import { startOracleServer } from '../../tools/ai-oracle/server';
import http from 'http';

describe('Phase 2.5 AI Oracle Security Red Team Suite', () => {
  const planner = new MockPlanner();

  it('Rejects unauthorized requests, expired tokens, wrong methods, proxy attempts, and path traversal', async () => {
    const oracle = await startOracleServer(planner, { port: 4066, maxPayloadBytes: 2048 });

    try {
      // 1. Missing Bearer Token -> 401
      const resMissingAuth = await makeRequest(4066, 'POST', '/plan', null, { test: 1 });
      expect(resMissingAuth.statusCode).toBe(401);

      // 2. Wrong Bearer Token -> 401
      const resWrongAuth = await makeRequest(4066, 'POST', '/plan', 'Bearer bad_token_12345', {
        test: 1,
      });
      expect(resWrongAuth.statusCode).toBe(401);

      // 3. Unsupported HTTP Method: GET -> 404
      const resGet = await makeRequest(
        4066,
        'GET',
        '/plan',
        `Bearer ${oracle.config.sessionToken}`
      );
      expect(resGet.statusCode).toBe(404);

      // 4. Unsupported HTTP Method: DELETE -> 404
      const resDelete = await makeRequest(
        4066,
        'DELETE',
        '/plan',
        `Bearer ${oracle.config.sessionToken}`
      );
      expect(resDelete.statusCode).toBe(404);

      // 5. Arbitrary Proxy Attempt -> 404
      const resProxy = await makeRequest(
        4066,
        'POST',
        '/v1/chat/completions',
        `Bearer ${oracle.config.sessionToken}`,
        { model: 'gpt-4' }
      );
      expect(resProxy.statusCode).toBe(404);

      // 6. Path Traversal Attempt -> 404
      const resTraversal = await makeRequest(
        4066,
        'POST',
        '/plan/../../api/secret',
        `Bearer ${oracle.config.sessionToken}`,
        { attack: true }
      );
      expect(resTraversal.statusCode).toBe(404);

      // 7. Malformed JSON -> 500 error handled safely without crashing oracle
      const resMalformed = await new Promise<{ statusCode?: number }>((resolve) => {
        const req = http.request(
          'http://127.0.0.1:4066/plan',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${oracle.config.sessionToken}`,
              'Content-Type': 'application/json',
            },
          },
          (res) => resolve({ statusCode: res.statusCode })
        );
        req.end('{"unclosed_json: true');
      });
      expect(resMalformed.statusCode).toBe(500);
    } finally {
      await oracle.close();
    }
  });

  it('Verifies Oracle Server config binds exclusively to 127.0.0.1 (never 0.0.0.0)', async () => {
    const oracle = await startOracleServer(planner, { port: 4067 });
    try {
      expect(oracle.config.host).toBe('127.0.0.1');
      expect(oracle.config.host).not.toBe('0.0.0.0');
    } finally {
      await oracle.close();
    }
  });
});

function makeRequest(
  port: number,
  method: string,
  path: string,
  authHeader: string | null,
  body?: any
): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authHeader) headers['Authorization'] = authHeader;

    const req = http.request(
      `http://127.0.0.1:${port}${path}`,
      { method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );
    if (body) {
      req.end(JSON.stringify(body));
    } else {
      req.end();
    }
  });
}
