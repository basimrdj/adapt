import {
  classifyPopupDestination,
  decidePopupOpen,
  PopupActivationContext,
} from '../page/popup-broker-policy';

function eventElement(event: Event): HTMLElement | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const candidate = path.find((value): value is HTMLElement => value instanceof HTMLElement);
  if (candidate) return candidate;
  return event.target instanceof HTMLElement ? event.target : null;
}

function classifyProtectedFlow(element: HTMLElement | null): boolean {
  if (!element) return false;
  if (element.hasAttribute('download')) return true;
  const href = element instanceof HTMLAnchorElement ? element.href : '';
  return /oauth|authorize|signin|login|pay|checkout|billing|purchase|\.(pdf|docx?|xlsx?|zip)(?:$|\?)/i.test(href);
}

function activationFromEvent(event: Event): PopupActivationContext {
  const element = eventElement(event)?.closest<HTMLElement>('a,button,[role="button"],video,[data-play],[aria-label]') ?? null;
  const anchor = element instanceof HTMLAnchorElement ? element : null;
  const modifiers = event instanceof MouseEvent
    ? event.metaKey || event.ctrlKey || event.button === 1
    : false;
  const expectedNewContext = Boolean(anchor?.target === '_blank' || modifiers);
  const expectedDestinationKey = anchor?.href
    ? classifyPopupDestination(anchor.href, window.location.href).key
    : undefined;
  const protectedFlow = classifyProtectedFlow(element);
  return {
    deadlineMs: Date.now() + (protectedFlow ? 1800 : 900),
    expectedNewContext,
    protectedFlow,
    expectedDestinationKey,
    openedCount: 0,
  };
}

function installPopupBroker(): void {
  const originalOpen = window.open.bind(window);
  let activation: PopupActivationContext | undefined;
  let installed = true;

  const capture = (event: Event): void => {
    if ('isTrusted' in event && event.isTrusted === false) return;
    activation = activationFromEvent(event);
  };
  const captureKey = (event: Event): void => {
    if (event instanceof KeyboardEvent && (event.key === 'Enter' || event.key === ' ')) capture(event);
  };

  window.addEventListener('pointerdown', capture, true);
  window.addEventListener('click', capture, true);
  window.addEventListener('keydown', captureKey, true);

  const broker = function popupBroker(
    rawUrl?: string | URL,
    target?: string,
    features?: string,
  ): Window | null {
    if (!installed) return originalOpen(rawUrl?.toString() || '', target, features);
    const destination = classifyPopupDestination(
      typeof rawUrl === 'string' ? rawUrl : rawUrl instanceof URL ? rawUrl.toString() : '',
      window.location.href,
    );
    const decision = decidePopupOpen(activation, destination, Date.now());
    if (!decision.allow) return null;
    if (activation) activation.openedCount += 1;
    return originalOpen(rawUrl?.toString() || '', target, features);
  };

  try {
    Object.defineProperty(window, 'open', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: broker,
    });
  } catch {
    // Pages can expose a non-configurable replacement; keep the extension alive.
    installed = false;
  }

  // Per-site pause stand-down: the isolated-world gate posts a transient
  // message when the user has paused this host. On receipt the broker fully
  // disarms — listeners removed, window.open restored to the native function.
  // Note: window.postMessage is page-reachable, so a sufficiently motivated
  // page could forge this signal. The broker is a UX heuristic, not a security
  // boundary — a page with script access already has stronger popup vectors —
  // and the message leaves no persistent, fingerprintable marker.
  window.addEventListener('message', (event) => {
    if (!installed || event.source !== window) return;
    const data = event.data as { kind?: string } | null;
    if (data?.kind !== 'adapt-popup-broker-standdown') return;
    installed = false;
    window.removeEventListener('pointerdown', capture, true);
    window.removeEventListener('click', capture, true);
    window.removeEventListener('keydown', captureKey, true);
    try {
      Object.defineProperty(window, 'open', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: originalOpen,
      });
    } catch {
      /* never throw into the page */
    }
  });
}

if (typeof window !== 'undefined' && typeof window.open === 'function') {
  installPopupBroker();
}
