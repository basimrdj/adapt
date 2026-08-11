import { describe, it, expect } from 'vitest';
import { normalizeUrlForTelemetry } from '../../src/core/network/normalize-url';

describe('URL Normalizer', () => {
  it('strips query parameters, tokens, and hash fragments for privacy', () => {
    const raw = 'https://ad-tracker.net/pixel/track.gif?user_id=12345&email=test@example.com&token=secret#section';
    const normalized = normalizeUrlForTelemetry(raw);

    expect(normalized.hostname).toBe('ad-tracker.net');
    expect(normalized.origin).toBe('https://ad-tracker.net');
    expect(normalized.coarsePath).toBe('/pixel/track.gif');
    expect(normalized.isSecure).toBe(true);
  });

  it('handles malformed URLs gracefully', () => {
    const normalized = normalizeUrlForTelemetry('not-a-valid-url');
    expect(normalized.hostname).toBe('');
    expect(normalized.origin).toBe('');
  });
});
