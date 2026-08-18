import { hashOrigin } from './causal/events';

export interface ResourceIdentity {
  origin: string;
  pathname: string;
  hostname: string;
  hash: string;
}

/**
 * Well-known compound public suffixes. A full public-suffix list is out of
 * scope; this covers the common two-label registries so their registrable
 * domain keeps three labels instead of collapsing onto the suffix itself
 * ('pixel.ads.example.co.uk' → 'example.co.uk', never 'co.uk').
 */
const COMPOUND_PUBLIC_SUFFIXES = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'ltd.uk', 'me.uk', 'net.uk', 'nhs.uk', 'org.uk', 'plc.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'ac.nz', 'govt.nz',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ne.kr', 'ac.kr', 'go.kr',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'gov.in', 'ac.in',
  'co.za', 'net.za', 'org.za', 'gov.za', 'ac.za',
  'com.mx', 'net.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'com.sg', 'net.sg', 'org.sg', 'gov.sg', 'edu.sg',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  'co.id', 'or.id', 'ac.id', 'go.id',
  'co.th', 'or.th', 'ac.th', 'go.th',
  'com.tw', 'net.tw', 'org.tw', 'edu.tw', 'gov.tw',
  'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'edu.ar',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr',
  'co.il', 'net.il', 'org.il', 'ac.il', 'gov.il',
  'com.ph', 'net.ph', 'org.ph', 'gov.ph', 'edu.ph',
  'com.pk', 'net.pk', 'org.pk', 'gov.pk', 'edu.pk',
  'com.ng', 'net.ng', 'org.ng', 'gov.ng', 'edu.ng',
  'com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn',
]);

export function registrableDomain(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/^www\./, '');
  const labels = normalized.split('.').filter(Boolean);
  if (labels.length <= 2 || labels.every((label) => /^\d+$/.test(label))) return normalized;
  const lastTwo = labels.slice(-2).join('.');
  if (COMPOUND_PUBLIC_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
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
