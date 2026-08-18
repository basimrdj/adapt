/**
 * Protected-flow network guard: dedicated authentication/identity hosts, their
 * critical dependency CDNs, captcha providers, and payment/3DS hosts are a
 * protected class for every LEARNED rule plane (personal learning, survivor AI,
 * autonomy recipes). Sign-in and checkout flows hard-fail when a subresource is
 * blocked — the Azure/Entra `unknown_msal_error`/`[object Event]` boot class,
 * and the Google chooser dead-click class, where one blocked sign-in JS module
 * (www.gstatic.com/_/mss/boq-identity/…AccountsSignInUi…) leaves the page
 * rendering pixel-perfect but every click inert (mechanism proven by
 * interception repro: render OK, progression none, heal restores).
 *
 * This mirrors the `authOrPayment` protected context in survivor discovery
 * (src/page/survivor-discovery.ts), one plane up: nothing learned may ever
 * block these hosts, and any legacy rule that predates the guard is purged at
 * startup. The static declarative rulesets are manifest-owned and out of scope
 * here (they ship upstream-vetted exception rules for these same hosts).
 *
 * Scope discipline:
 * - Only DEDICATED flow domains belong in the host lists — a host whose
 *   primary purpose is auth/captcha/payment or serving those flows' code.
 *   Content domains with a login path (github.com, facebook.com, google.com
 *   itself) must NOT be listed: the guard protects by whole host.
 * - Mixed-use giants are protected by HOST+PATH pair instead (e.g. reCAPTCHA
 *   under google.com/recaptcha/) so ad surfaces on the same host stay covered.
 * - The guard restrains only the LEARNED planes; static list policy (including
 *   AdGuard Popups' ||accounts.google.com/gsi/client^ third-party suppression
 *   on its listed sites) is upstream intent and is not overridden here.
 */

/** Dedicated identity hosts: whose primary purpose is authentication. */
const PROTECTED_AUTH_HOSTS: readonly string[] = [
  // Microsoft Entra / MSA
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.live.com',
  'msauth.net', // covers aadcdn.msauth.net, logincdn.msauth.net
  'msftauth.net', // covers aadcdn.msftauth.net
  'msftauthimages.net',
  // Google
  'accounts.google.com',
  'accounts.youtube.com',
  // Apple
  'appleid.apple.com',
  'idmsa.apple.com',
  // AWS console + Cognito hosted UI
  'signin.aws.amazon.com',
  'amazoncognito.com',
  // Major identity providers / platforms
  'login.yahoo.com',
  'id.atlassian.com',
  'login.salesforce.com',
  'okta.com', // tenant subdomains: <org>.okta.com
  'auth0.com', // tenant subdomains: <org>.auth0.com
];

/**
 * Identity-flow dependency CDNs. These serve the JavaScript that makes sign-in
 * pages INTERACTIVE — blocking one module renders fine and kills every click
 * (the Google chooser dead-click class). Their telemetry endpoints
 * (csi.gstatic.com, firebaselogging-pa.googleapis.com) remain covered by the
 * static lists, which this guard never touches.
 */
const PROTECTED_AUTH_DEPENDENCY_HOSTS: readonly string[] = [
  'gstatic.com', // accounts.gstatic.com, ssl/www.gstatic.com — sign-in JS + CSS
  'gstatic.cn',
  'googleapis.com', // apis clients, fonts, identity toolkit
  'apis.google.com', // platform.js — powers "Sign in with Google" buttons
  'cdn-apple.com', // appleid.cdn-apple.com, applepay.cdn-apple.com
];

/**
 * Captcha providers. Login/checkout captchas are flow-critical: a blocked
 * challenge script silently disables the submit button. Telemetry subpaths of
 * these hosts stay list-covered.
 */
const PROTECTED_CAPTCHA_HOSTS: readonly string[] = [
  'recaptcha.net',
  'hcaptcha.com',
  'challenges.cloudflare.com', // Turnstile
  'arkoselabs.com',
  'funcaptcha.com',
  'geetest.com',
  'captchafox.com',
  'friendlycaptcha.com',
  'mtcaptcha.com',
];

/**
 * Payment / 3DS / checkout hosts. A blocked SDK or 3DS iframe kills checkout
 * with no visible error — the payment twin of the sign-in boot class.
 */
const PROTECTED_PAYMENT_HOSTS: readonly string[] = [
  'stripe.com',
  'stripecdn.com',
  'stripe.network',
  'paypal.com',
  'paypalobjects.com',
  'venmo.com',
  'braintreegateway.com',
  'braintree-api.com',
  'adyen.com',
  'klarna.com',
  'klarnacdn.net',
  'squareup.com',
  'squarecdn.com',
  'authorize.net',
  'checkout.com',
  'mollie.com',
  'razorpay.com',
  'alipay.com',
  '2checkout.com',
  'worldpay.com',
  'affirm.com',
  'afterpay.com',
  'sezzle.com',
  'shop.app', // Shop Pay
  'payments.amazon.com',
  'pay.amazon.com',
  'pay.google.com', // Google Pay / Google Wallet checkout
];

/**
 * Host+path pairs for flow-critical endpoints on mixed-use giants that must
 * stay blockable elsewhere (google.com search ads must remain covered).
 */
const PROTECTED_FLOW_PATH_PAIRS: ReadonlyArray<{ host: string; pathPrefix: string }> = [
  { host: 'google.com', pathPrefix: '/recaptcha/' }, // reCAPTCHA on login/checkout pages
];

const AUTH_HOST_SET = new Set(PROTECTED_AUTH_HOSTS);
const DEPENDENCY_HOST_SET = new Set(PROTECTED_AUTH_DEPENDENCY_HOSTS);
const CAPTCHA_HOST_SET = new Set(PROTECTED_CAPTCHA_HOSTS);
const PAYMENT_HOST_SET = new Set(PROTECTED_PAYMENT_HOSTS);

function hostInSet(hostname: string, set: ReadonlySet<string>): boolean {
  if (set.has(hostname)) return true;
  // Dot-boundary suffix walk: a.b.gstatic.com → b.gstatic.com → gstatic.com.
  let host = hostname;
  let dot = host.indexOf('.');
  while (dot !== -1) {
    host = host.slice(dot + 1);
    if (set.has(host)) return true;
    dot = host.indexOf('.');
  }
  return false;
}

/**
 * True when `hostname` IS or LIVES UNDER a protected auth host. The suffix test
 * requires a dot boundary, so `evil-msauth.net` / `msauth.net.evil.com` do not
 * match. Unknown/empty hosts never match.
 */
export function isProtectedAuthHost(hostname: string | undefined | null): boolean {
  if (!hostname) return false;
  return hostInSet(hostname.toLowerCase(), AUTH_HOST_SET);
}

/** True for identity-flow dependency CDNs (sign-in JS/CSS must load). */
export function isProtectedAuthDependencyHost(hostname: string | undefined | null): boolean {
  if (!hostname) return false;
  return hostInSet(hostname.toLowerCase(), DEPENDENCY_HOST_SET);
}

/** True for captcha provider hosts (login/checkout challenges must load). */
export function isProtectedCaptchaHost(hostname: string | undefined | null): boolean {
  if (!hostname) return false;
  return hostInSet(hostname.toLowerCase(), CAPTCHA_HOST_SET);
}

/** True for payment/3DS/checkout hosts (payment SDKs + bank flows must load). */
export function isProtectedPaymentHost(hostname: string | undefined | null): boolean {
  if (!hostname) return false;
  return hostInSet(hostname.toLowerCase(), PAYMENT_HOST_SET);
}

/**
 * True when `hostname` belongs to ANY protected-flow class (identity,
 * identity-dependency, captcha, payment). This is the predicate every learned
 * rule plane must consult before birth/promotion.
 */
export function isProtectedFlowHost(hostname: string | undefined | null): boolean {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  return (
    hostInSet(host, AUTH_HOST_SET)
    || hostInSet(host, DEPENDENCY_HOST_SET)
    || hostInSet(host, CAPTCHA_HOST_SET)
    || hostInSet(host, PAYMENT_HOST_SET)
  );
}

/** Forensics-safe one-line summary of the protected classes (no host values). */
export const PROTECTED_AUTH_HOST_COUNT = PROTECTED_AUTH_HOSTS.length;
export const PROTECTED_FLOW_HOST_COUNT =
  PROTECTED_AUTH_HOSTS.length
  + PROTECTED_AUTH_DEPENDENCY_HOSTS.length
  + PROTECTED_CAPTCHA_HOSTS.length
  + PROTECTED_PAYMENT_HOSTS.length;

/**
 * True when filter text (urlFilter or regexFilter, any dialect: `|https://…`,
 * `||host/…^`, regex with escaped dots) names a protected-flow host or a
 * protected host+path pair. Host tokens are extracted and tested with
 * dot-boundary suffix semantics, so `notmsauth.net` does not match
 * `msauth.net`. Path pairs match by containment on the unescaped text, which
 * covers `||google.com/recaptcha/…^`, `|https://www.google.com/recaptcha/…`,
 * and `google\.com/recaptcha` regex forms alike.
 */
export function filterTextMentionsProtectedFlow(text: string): boolean {
  const unescaped = text.replace(/\\\./g, '.').replace(/\\\//g, '/').toLowerCase();
  for (const token of unescaped.split(/[^a-z0-9.-]+/)) {
    if (token.length > 0 && isProtectedFlowHost(token)) return true;
  }
  for (const pair of PROTECTED_FLOW_PATH_PAIRS) {
    if (unescaped.includes(`${pair.host}${pair.pathPrefix}`)) return true;
  }
  return false;
}

/** Back-compat alias: the auth-host-only text check. */
export function filterTextMentionsProtectedAuthHost(text: string): boolean {
  const unescaped = text.replace(/\\\./g, '.').toLowerCase();
  for (const token of unescaped.split(/[^a-z0-9.-]+/)) {
    if (token.length > 0 && isProtectedAuthHost(token)) return true;
  }
  return false;
}

/**
 * True when a DNR rule's TARGET condition reaches a protected flow. Only the
 * request target matters (urlFilter / regexFilter / requestDomains) —
 * initiatorDomains scope WHERE a rule applies, not what it blocks, so a rule
 * scoped to a login page that blocks a tracker is not poison.
 */
export function ruleTargetsProtectedFlow(rule: chrome.declarativeNetRequest.Rule): boolean {
  const condition = rule.condition;
  for (const host of condition.requestDomains ?? []) {
    if (isProtectedFlowHost(String(host))) return true;
  }
  const text = [condition.urlFilter, condition.regexFilter]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
  return text.length > 0 && filterTextMentionsProtectedFlow(text);
}

/** Back-compat alias kept for existing call sites/tests. */
export function ruleTargetsProtectedAuthHost(rule: chrome.declarativeNetRequest.Rule): boolean {
  return ruleTargetsProtectedFlow(rule);
}
