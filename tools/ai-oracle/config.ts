import crypto from 'crypto';

export interface OracleConfig {
  host: string;
  port: number;
  maxPayloadBytes: number;
  requestTimeoutMs: number;
  sessionToken: string;
}

export function createOracleConfig(port = 4040): OracleConfig {
  return {
    host: '127.0.0.1', // Strictly localhost only
    port,
    maxPayloadBytes: 50 * 1024, // 50 KB max
    requestTimeoutMs: 15000,
    sessionToken: crypto.randomBytes(24).toString('hex'),
  };
}
