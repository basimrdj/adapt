import http from 'http';
import { OracleConfig, createOracleConfig } from './config';
import { AdaptivePlanner } from '../../src/shared/ai/planner-interface';
import { EvidencePacket } from '../../src/shared/ai/types';
import { PolicyValidator } from '../../src/shared/ai/validator';

export interface OracleServerInstance {
  server: http.Server;
  config: OracleConfig;
  close: () => Promise<void>;
}

export function startOracleServer(
  planner: AdaptivePlanner,
  customConfig?: Partial<OracleConfig>
): Promise<OracleServerInstance> {
  const config = { ...createOracleConfig(), ...customConfig };
  const validator = new PolicyValidator();

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // 1. Enforce Localhost & Method
      if (req.method !== 'POST' || req.url !== '/plan') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }

      // 2. Validate Ephemeral Bearer Token
      const authHeader = req.headers.authorization || '';
      const expectedAuth = `Bearer ${config.sessionToken}`;
      if (authHeader !== expectedAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid Session Token' }));
        return;
      }

      // 3. Receive and Enforce Payload Size Limit
      let body = '';
      let bytesReceived = 0;

      req.on('data', (chunk) => {
        bytesReceived += chunk.length;
        if (bytesReceived > config.maxPayloadBytes) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload Too Large' }));
          req.destroy();
          return;
        }
        body += chunk;
      });

      req.on('end', async () => {
        try {
          const evidence = JSON.parse(body) as EvidencePacket;
          const plan = await planner.plan(evidence);

          // Policy validate the plan before returning to the caller
          const validation = validator.validate(evidence, plan);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              plan,
              validation,
            })
          );
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message || 'Internal Oracle Error' }));
        }
      });
    });

    server.listen(config.port, config.host, () => {
      resolve({
        server,
        config,
        close: async () => {
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });

    server.on('error', (err) => reject(err));
  });
}
