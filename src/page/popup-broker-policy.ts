import { isProtectedAuthHost, isProtectedPaymentHost } from '../shared/protected-flows';

export type PopupDestinationClass =
  | 'same-origin'
  | 'cross-origin'
  | 'oauth-like'
  | 'payment-like'
  | 'document'
  | 'download'
  | 'unknown';

export interface PopupActivationContext {
  deadlineMs: number;
  expectedNewContext: boolean;
  protectedFlow: boolean;
  expectedDestinationKey?: string;
  openedCount: number;
}

export interface PopupDestination {
  className: PopupDestinationClass;
  key?: string;
}

export interface PopupOpenDecision {
  allow: boolean;
  reason: 'no-activation' | 'extra-target' | 'protected-flow' | 'expected-target' | 'unexpected-target';
}

const PROTECTED_CLASSES = new Set<PopupDestinationClass>([
  'oauth-like',
  'payment-like',
  'document',
  'download',
]);

/**
 * OAuth SDKs (GIS, MSAL, Auth0) frequently open the popup from an async
 * continuation after a config/token fetch, long after the raw click. The base
 * activation deadline exists to suppress nag popups with no gesture behind
 * them; a protected destination WITH a recent gesture gets an extended window
 * instead — the destination class itself is the safety property.
 */
const PROTECTED_DEADLINE_EXTENSION_MS = 4_000;

export function classifyPopupDestination(rawUrl: unknown, sourceUrl: string): PopupDestination {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return { className: 'unknown' };
  }

  try {
    const destination = new URL(rawUrl, sourceUrl);
    const path = destination.pathname.toLowerCase();
    // Host-aware first: dedicated identity/payment hosts classify by host, so
    // continuation paths with no keyword (/AccountChooser, /CompleteSignIn,
    // /ppsecure) no longer dead-end at 'cross-origin' and get denied.
    const className: PopupDestinationClass =
      isProtectedAuthHost(destination.hostname)
        ? 'oauth-like'
        : isProtectedPaymentHost(destination.hostname)
          ? 'payment-like'
          : /oauth|authorize|signin|login/.test(path)
            ? 'oauth-like'
            : /pay|checkout|billing|purchase/.test(path)
              ? 'payment-like'
              : /\.(pdf|docx?|xlsx?|zip)$/.test(path)
                ? 'document'
                : destination.origin === new URL(sourceUrl).origin
                  ? 'same-origin'
                  : 'cross-origin';
    const firstPathSegment = path.split('/').filter(Boolean)[0] || 'root';
    return {
      className,
      key: `${destination.origin}|${firstPathSegment}|${className}`,
    };
  } catch {
    return { className: 'unknown' };
  }
}

export function decidePopupOpen(
  activation: PopupActivationContext | undefined,
  destination: PopupDestination,
  nowMs: number,
): PopupOpenDecision {
  if (!activation) {
    return { allow: false, reason: 'no-activation' };
  }
  const protectedFlow = activation.protectedFlow || PROTECTED_CLASSES.has(destination.className);
  const effectiveDeadlineMs = protectedFlow
    ? activation.deadlineMs + PROTECTED_DEADLINE_EXTENSION_MS
    : activation.deadlineMs;
  if (nowMs > effectiveDeadlineMs) {
    return { allow: false, reason: 'no-activation' };
  }
  if (activation.openedCount > 0) {
    return { allow: false, reason: 'extra-target' };
  }
  if (protectedFlow) {
    return { allow: true, reason: 'protected-flow' };
  }
  if (
    activation.expectedNewContext &&
    Boolean(destination.key) &&
    destination.key === activation.expectedDestinationKey
  ) {
    return { allow: true, reason: 'expected-target' };
  }
  return { allow: false, reason: 'unexpected-target' };
}
