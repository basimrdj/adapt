/**
 * Privacy-preserving URL normalizer.
 * Redacts query strings, authentication tokens, and hash fragments from telemetry.
 */

export interface NormalizedUrl {
  origin: string;
  hostname: string;
  coarsePath: string;
  isSecure: boolean;
}

export function normalizeUrlForTelemetry(rawUrl: string): NormalizedUrl {
  try {
    const parsed = new URL(rawUrl);
    // Take only up to 2 path segments for coarse grouping
    const segments = parsed.pathname.split('/').filter(Boolean).slice(0, 2);
    const coarsePath = segments.length > 0 ? `/${segments.join('/')}` : '/';

    return {
      origin: parsed.origin,
      hostname: parsed.hostname.toLowerCase(),
      coarsePath,
      isSecure: parsed.protocol === 'https:',
    };
  } catch {
    return {
      origin: '',
      hostname: '',
      coarsePath: '',
      isSecure: false,
    };
  }
}
