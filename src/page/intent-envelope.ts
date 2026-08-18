import { hashOrigin } from '../shared/causal/events';
import { isProtectedAuthHost, isProtectedPaymentHost } from '../shared/protected-flows';
import {
  DestinationClass,
  ElementSemanticRole,
  InteractionType,
  UserIntentEnvelope,
} from '../shared/types';
import { OpaqueTargetRegistry } from './opaque-targets';

let intentSequence = 0;

function nextIntentRef(): `intent:i${number}` {
  intentSequence += 1;
  return `intent:i${intentSequence}`;
}

function roleFor(element: HTMLElement): ElementSemanticRole {
  const tag = element.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button' || element.getAttribute('role') === 'button') return 'button';
  if (tag === 'video' || element.closest('video')) return 'media-control';
  return 'unknown';
}

function destinationClassFor(element: HTMLElement): DestinationClass {
  if (element.hasAttribute('download')) return 'download';
  const rawHref = element instanceof HTMLAnchorElement ? element.href : '';
  if (!rawHref) return 'unknown';
  try {
    const destination = new URL(rawHref, window.location.href);
    if (destination.origin === window.location.origin) return 'same-origin';
    if (/oauth|authorize|signin|login/i.test(destination.pathname)) return 'oauth-like';
    if (/pay|checkout|billing|purchase/i.test(destination.pathname)) return 'payment-like';
    if (/\.pdf$|\.docx?$|\.xlsx?$|\.zip$/i.test(destination.pathname)) return 'document';
    return 'cross-origin';
  } catch {
    return 'unknown';
  }
}

function destinationFingerprintFor(element: HTMLElement, destinationClass: DestinationClass): string | undefined {
  if (destinationClass === 'download') return hashOrigin('download:root');
  const rawHref = element instanceof HTMLAnchorElement ? element.href : '';
  if (!rawHref) return undefined;
  try {
    const destination = new URL(rawHref, window.location.href);
    const pathClass = destination.pathname.split('/').filter(Boolean)[0] ?? 'root';
    return `${hashOrigin(destination.origin)}:${destinationClass}:${pathClass}`;
  } catch {
    return undefined;
  }
}

function targetBehaviorFor(element: HTMLElement, destinationClass: DestinationClass): UserIntentEnvelope['targetBehavior'] {
  if (destinationClass === 'download') return 'download';
  if (element instanceof HTMLAnchorElement && element.target === '_blank') return 'new-context';
  return destinationClass === 'unknown' ? 'unknown' : 'same-context';
}

function relevantTarget(event: Event): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return null;
  return target.closest<HTMLElement>('a,button,[role="button"],video,[data-play],[aria-label]');
}

/**
 * Protected-transaction intent detection (Layer 2 trigger). A trusted click on
 * a flow-shaped element begins conservative mode for the tab even when the
 * element has no href (JS-driven "Sign in with Google" buttons, "Pay" buttons
 * whose 3DS iframe loads on an unenumerable bank host). Patterns are
 * word-boundary disciplined — `display`, `repay`, `signage` never match.
 * Recall beats precision here by design: a false positive costs a few minutes
 * of conservative mode on one tab; a false negative costs a broken login.
 */
const PROTECTED_AUTH_TEXT = /(sign[ -]?in|log[ -]?in|sign[ -]?up|continue with|verify (your|account|identity)|passkey)/i;
const PROTECTED_PAYMENT_TEXT = /(check[ -]?out|place order|complete (purchase|order)|billing|paypal|apple pay|google pay|([^a-z]|^)pay(now| later| with| secure)?([^a-z]|$))/i;

export function protectedTransactionIntentFor(event: Event): 'auth' | 'payment' | null {
  const element = relevantTarget(event);
  if (!element) return null;
  const rawHref = element instanceof HTMLAnchorElement ? element.href : '';
  if (rawHref) {
    try {
      const destination = new URL(rawHref, window.location.href);
      if (isProtectedAuthHost(destination.hostname)) return 'auth';
      if (isProtectedPaymentHost(destination.hostname)) return 'payment';
      if (/oauth|authorize|signin|login/i.test(destination.pathname)) return 'auth';
      if (/pay|checkout|billing|purchase/i.test(destination.pathname)) return 'payment';
    } catch {
      /* fall through to text */
    }
  }
  const text = [
    element.getAttribute('aria-label') || '',
    element.getAttribute('title') || '',
    (element.textContent || '').slice(0, 120),
    element.id,
    typeof element.className === 'string' ? element.className : '',
    element instanceof HTMLInputElement ? element.value : '',
  ].join(' ');
  if (PROTECTED_PAYMENT_TEXT.test(text)) return 'payment';
  if (PROTECTED_AUTH_TEXT.test(text)) return 'auth';
  return null;
}

export function createIntentEnvelope(
  event: MouseEvent,
  targets: OpaqueTargetRegistry,
  interactionType: InteractionType = 'click'
): UserIntentEnvelope | null {
  const element = relevantTarget(event);
  if (!element) return null;
  const ref = targets.register(element);
  const role = roleFor(element);
  const destinationClass = destinationClassFor(element);
  const targetBehavior = targetBehaviorFor(element, destinationClass);
  const newContextReasonablyExpected = targetBehavior === 'new-context'
    || event.button === 1
    || event.metaKey
    || event.ctrlKey;
  return {
    ref: nextIntentRef(),
    documentMonotonicMs: typeof performance.now === 'function' ? performance.now() : 0,
    capturedWallMs: Date.now(),
    elementRef: ref,
    elementRole: role,
    declaredDestinationClass: destinationClass,
    declaredDestinationFingerprint: destinationFingerprintFor(element, destinationClass),
    button: event.button,
    modifiers: [
      event.altKey ? 'alt' : '',
      event.ctrlKey ? 'ctrl' : '',
      event.metaKey ? 'meta' : '',
      event.shiftKey ? 'shift' : '',
    ].filter(Boolean),
    interactionType,
    navigationReasonablyExpected:
      role === 'link' || role === 'button' && destinationClass !== 'unknown',
    sourceOriginHash: hashOrigin(window.location.origin),
    eventTrusted: event.isTrusted,
    targetBehavior,
    newContextReasonablyExpected,
    downloadLikeIntent: destinationClass === 'download',
  };
}
