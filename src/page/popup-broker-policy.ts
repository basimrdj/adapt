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

export function classifyPopupDestination(rawUrl: unknown, sourceUrl: string): PopupDestination {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return { className: 'unknown' };
  }

  try {
    const destination = new URL(rawUrl, sourceUrl);
    const path = destination.pathname.toLowerCase();
    const className: PopupDestinationClass =
      /oauth|authorize|signin|login/.test(path)
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
  if (!activation || nowMs > activation.deadlineMs) {
    return { allow: false, reason: 'no-activation' };
  }
  if (activation.openedCount > 0) {
    return { allow: false, reason: 'extra-target' };
  }
  if (activation.protectedFlow || PROTECTED_CLASSES.has(destination.className)) {
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
