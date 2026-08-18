/**
 * Protected-transaction intent classifier (Layer 2 click trigger): trusted
 * clicks on flow-shaped elements must begin conservative mode — including
 * href-less JS buttons ("Sign in with Google") — with word-boundary discipline
 * so ordinary UI text never trips it. Runs with minimal DOM stubs (no jsdom).
 */

class FakeHTMLElement {
  tagName = 'DIV';
  id = '';
  className = '';
  textContent = '';
  href = '';
  value = '';
  private attrs = new Map<string, string>();
  closest(): FakeHTMLElement | null {
    return this;
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
}

class FakeAnchor extends FakeHTMLElement {
  tagName = 'A';
  constructor(href: string) {
    super();
    this.href = href;
  }
}

class FakeInput extends FakeHTMLElement {
  tagName = 'INPUT';
}

(globalThis as unknown as Record<string, unknown>).HTMLElement = FakeHTMLElement;
(globalThis as unknown as Record<string, unknown>).HTMLAnchorElement = FakeAnchor;
(globalThis as unknown as Record<string, unknown>).HTMLInputElement = FakeInput;
(globalThis as unknown as Record<string, unknown>).window = {
  location: { href: 'https://shop.example.com/checkout', origin: 'https://shop.example.com' },
};

import { describe, expect, it } from 'vitest';
import { protectedTransactionIntentFor } from '../../src/page/intent-envelope';

function clickEvent(element: FakeHTMLElement): Event {
  return { target: element } as unknown as Event;
}

describe('protectedTransactionIntentFor (Layer 2 click trigger)', () => {
  it('href to protected hosts classifies by host, regardless of path keywords', () => {
    expect(protectedTransactionIntentFor(clickEvent(new FakeAnchor('https://accounts.google.com/AccountChooser?continue=x')))).toBe('auth');
    expect(protectedTransactionIntentFor(clickEvent(new FakeAnchor('https://login.live.com/ppsecure/post.srf')))).toBe('auth');
    expect(protectedTransactionIntentFor(clickEvent(new FakeAnchor('https://js.stripe.com/v3')))).toBe('payment');
    expect(protectedTransactionIntentFor(clickEvent(new FakeAnchor('https://paypal.com/checkoutnow')))).toBe('payment');
  });

  it('pathname keyword fallback covers unregistered providers', () => {
    expect(protectedTransactionIntentFor(clickEvent(new FakeAnchor('https://idp.example.org/oauth2/authorize')))).toBe('auth');
    expect(protectedTransactionIntentFor(clickEvent(new FakeAnchor('https://shop.example.com/checkout')))).toBe('payment');
  });

  it('href-less flow buttons classify by element text (GIS/MSAL JS-button class)', () => {
    const signIn = new FakeHTMLElement();
    signIn.textContent = 'Sign in with Google';
    expect(protectedTransactionIntentFor(clickEvent(signIn))).toBe('auth');
    const pay = new FakeHTMLElement();
    pay.setAttribute('aria-label', 'Pay now');
    expect(protectedTransactionIntentFor(clickEvent(pay))).toBe('payment');
    const checkout = new FakeHTMLElement();
    checkout.textContent = 'Proceed to Checkout';
    expect(protectedTransactionIntentFor(clickEvent(checkout))).toBe('payment');
    const passkey = new FakeHTMLElement();
    passkey.textContent = 'Use a passkey';
    expect(protectedTransactionIntentFor(clickEvent(passkey))).toBe('auth');
  });

  it('ordinary UI never trips the classifier (word-boundary discipline)', () => {
    const readMore = new FakeAnchor('https://shop.example.com/blog/article');
    readMore.textContent = 'Read more';
    expect(protectedTransactionIntentFor(clickEvent(readMore))).toBe(null);
    const addToCart = new FakeHTMLElement();
    addToCart.textContent = 'Add to cart';
    expect(protectedTransactionIntentFor(clickEvent(addToCart))).toBe(null);
    const displayClass = new FakeHTMLElement();
    displayClass.className = 'display-4 signage';
    expect(protectedTransactionIntentFor(clickEvent(displayClass))).toBe(null);
    const repay = new FakeHTMLElement();
    repay.textContent = 'repayment schedule'; // word-char boundary: not a bare "pay"
    expect(protectedTransactionIntentFor(clickEvent(repay))).toBe(null);
    expect(protectedTransactionIntentFor({ target: null } as unknown as Event)).toBe(null);
  });
});
