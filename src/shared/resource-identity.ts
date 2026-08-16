import { hashOrigin } from './causal/events';

export interface ResourceIdentity {
  origin: string;
  pathname: string;
  hostname: string;
  hash: string;
}

export function registrableDomain(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/^www\./, '');
  const labels = normalized.split('.').filter(Boolean);
  if (labels.length <= 2 || labels.every((label) => /^\d+$/.test(label))) return normalized;
  return labels.slice(-2).join('.');
}

export function resourceIdentity(rawUrl: string, baseUrl?: string): ResourceIdentity | null {
  try {
    const parsed = new URL(rawUrl, baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    const origin = parsed.origin.toLowerCase();
    const pathname = parsed.pathname || '/';
    return {
      origin,
      pathname,
      hostname: parsed.hostname.toLowerCase(),
      hash: hashOrigin(`resource:${origin}${pathname}`),
    };
  } catch {
    return null;
  }
}

export function isThirdPartyResource(rawUrl: string, pageOrigin: string): boolean {
  const resource = resourceIdentity(rawUrl, pageOrigin);
  const page = resourceIdentity(pageOrigin);
  if (!resource || !page) return false;
  return resource.origin !== page.origin && registrableDomain(resource.hostname) !== registrableDomain(page.hostname);
}
