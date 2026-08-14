import { hashOrigin } from '../shared/causal/events';
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

function relevantTarget(event: Event): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return null;
  return target.closest<HTMLElement>('a,button,[role="button"],video,[data-play],[aria-label]');
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
  return {
    ref: nextIntentRef(),
    documentMonotonicMs: typeof performance.now === 'function' ? performance.now() : 0,
    capturedWallMs: Date.now(),
    elementRef: ref,
    elementRole: role,
    declaredDestinationClass: destinationClass,
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
  };
}
