import fs from 'fs';
import path from 'path';
import { EvidencePacket, PlanDecision } from '../src/shared/ai/types';

export interface EvaluationCase {
  id: string;
  split: 'dev' | 'holdout';
  category:
    | 'anti-adblock-gate'
    | 'bait-detector'
    | 'anti-adblock-probe'
    | 'partial-blur-gate'
    | 'benign-control'
    | 'benign-hybrid';
  subType: string;
  expectedDecision: PlanDecision;
  expectedStrategyTier: 'S1' | 'S2' | 'S3' | 'ABSTAIN';
  requiredActionTypes: string[];
  forbiddenActionTypes: string[];
  evidence: EvidencePacket;
}

function createCase(
  id: string,
  split: 'dev' | 'holdout',
  category: EvaluationCase['category'],
  subType: string,
  expectedDecision: PlanDecision,
  expectedStrategyTier: 'S1' | 'S2' | 'S3' | 'ABSTAIN',
  requiredActionTypes: string[],
  forbiddenActionTypes: string[],
  overrides?: Partial<EvidencePacket>
): EvaluationCase {
  const isBenign = category.startsWith('benign');
  const antiBlockScore = isBenign ? 0.1 : 0.85;

  const baseEvidence: EvidencePacket = {
    schemaVersion: 1,
    transactionId: `tx_eval_${id}`,
    navigationEpoch: `nav_eval_${id}`,
    timestamp: Date.now(),
    siteContext: {
      originClass: isBenign ? 'ecommerce' : 'publisher',
      pageTypeEstimate: 'article',
    },
    trigger: {
      reason: category.toUpperCase(),
      confidence: antiBlockScore,
    },
    healthBefore: {
      antiBlockReaction: antiBlockScore,
      contentAvailability: isBenign ? 0.95 : 0.2,
      interaction: isBenign ? 1.0 : 0.1,
      scrollability: isBenign ? 1.0 : 0.1,
      navigationHealth: 1.0,
      visualObstruction: isBenign ? 0.0 : 0.85,
      mutationStability: 1.0,
      confidence: 0.9,
    },
    currentHealth: {
      antiBlockReaction: antiBlockScore,
      contentAvailability: isBenign ? 0.95 : 0.2,
      interaction: isBenign ? 1.0 : 0.1,
      scrollability: isBenign ? 1.0 : 0.1,
      navigationHealth: 1.0,
      visualObstruction: isBenign ? 0.0 : 0.85,
      mutationStability: 1.0,
      confidence: 0.9,
    },
    observedReaction: {
      detectorTypes: isBenign ? [] : [subType.toUpperCase()],
      antiBlockConfidence: antiBlockScore,
      mutationBurstDetected: !isBenign,
    },
    candidateElements: [],
    candidateRequests: [],
    availableActions: [
      'DOM_REMOVE_OVERLAY',
      'DOM_RESTORE_SCROLL',
      'DOM_RESTORE_POINTER_EVENTS',
      'DOM_PRESERVE_BAIT',
      'ABSTAIN',
    ],
    knownConstraints: ['NO_ARBITRARY_JS', 'STRICT_OPAQUE_REFS_ONLY'],
    previousAttempts: [],
  };

  return {
    id,
    split,
    category,
    subType,
    expectedDecision,
    expectedStrategyTier,
    requiredActionTypes,
    forbiddenActionTypes,
    evidence: {
      ...baseEvidence,
      ...overrides,
    },
  };
}

export function generateCorpus(): EvaluationCase[] {
  const cases: EvaluationCase[] = [];
  let caseIdx = 0;

  const nextId = () => `case_${String(++caseIdx).padStart(3, '0')}`;
  const getSplit = (idx: number): 'dev' | 'holdout' => (idx % 5 === 0 ? 'holdout' : 'dev'); // 80% Dev (200), 20% Holdout (50)

  // ==========================================
  // 1. FULLSCREEN OVERLAYS & MODAL GATES (45 cases)
  // ==========================================
  const overlayPhrases = [
    'Ad blocker detected! Please disable your ad blocker to continue reading.',
    'We notice you are using an adblocker. Whitelist us to support our journalism.',
    'Please turn off your ad blocker or subscribe to our premium plan.',
    'Ads help keep our content free. Disable your ad blocker to proceed.',
    'Access blocked: Ad-blocking extension detected in your browser.',
  ];

  for (let i = 0; i < 45; i++) {
    const id = nextId();
    const split = getSplit(caseIdx);
    const phrase = overlayPhrases[i % overlayPhrases.length] || '';
    const isScrollLocked = i % 2 === 0;

    cases.push(
      createCase(
        id,
        split,
        'anti-adblock-gate',
        isScrollLocked ? 'fullscreen-and-scroll-lock' : 'fullscreen-overlay',
        'ADAPT',
        'S3',
        isScrollLocked
          ? ['DOM_REMOVE_OVERLAY', 'DOM_RESTORE_SCROLL', 'DOM_RESTORE_POINTER_EVENTS']
          : ['DOM_REMOVE_OVERLAY', 'DOM_RESTORE_POINTER_EVENTS'],
        ['NET_TEMP_BLOCK'],
        {
          candidateElements: [
            {
              ref: 'element:e1',
              role: 'fullscreen-overlay',
              viewportCoverage: 0.9 + (i % 10) * 0.01,
              isFixedOrAbsolute: true,
              hasHighZIndex: true,
              textSignals: [phrase, 'adblock', 'whitelist'],
              interactionSuppressed: true,
            },
          ],
        }
      )
    );
  }

  // ==========================================
  // 2. BAIT ELEMENT DETECTORS (30 cases)
  // ==========================================
  const baitClasses = [
    'ad-banner',
    'ads-box',
    'sponsor-slot',
    'google-ad-placeholder',
    'native-sponsor-item',
  ];

  for (let i = 0; i < 30; i++) {
    const id = nextId();
    const split = getSplit(caseIdx);
    const baitClass = baitClasses[i % baitClasses.length] || '';

    cases.push(
      createCase(
        id,
        split,
        'bait-detector',
        'bait-element-measurement',
        'ADAPT',
        'S2',
        ['DOM_PRESERVE_BAIT'],
        ['NET_TEMP_BLOCK', 'DOM_REMOVE_OVERLAY'],
        {
          candidateElements: [
            {
              ref: 'element:e1',
              role: 'bait-placeholder',
              viewportCoverage: 0.04,
              isFixedOrAbsolute: false,
              hasHighZIndex: false,
              textSignals: [baitClass, 'advertisement'],
              interactionSuppressed: false,
            },
          ],
        }
      )
    );
  }

  // ==========================================
  // 3. BLOCKED SCRIPT & PROBE PROFILES (30 cases)
  // ==========================================
  const probeDomains = [
    'pagead2.googlesyndication.com',
    'securepubads.g.doubleclick.net',
    'c.amazon-adsystem.com',
    'adnxs.com',
    'outbrain.com',
  ];

  for (let i = 0; i < 30; i++) {
    const id = nextId();
    const split = getSplit(caseIdx);
    const domain = probeDomains[i % probeDomains.length] || '';

    cases.push(
      createCase(
        id,
        split,
        'anti-adblock-probe',
        'blocked-script-probe',
        'ADAPT',
        'S3',
        ['DOM_REMOVE_OVERLAY'],
        ['NET_TEMP_BLOCK'],
        {
          candidateRequests: [
            {
              ref: 'request:r1',
              urlDomain: domain,
              resourceType: 'script',
              isBlockedByBaseline: true,
              failureObserved: true,
            },
          ],
          candidateElements: [
            {
              ref: 'element:e1',
              role: 'modal-gate',
              viewportCoverage: 0.75,
              isFixedOrAbsolute: true,
              hasHighZIndex: true,
              textSignals: ['Script error: ad blocker detected', 'please disable'],
              interactionSuppressed: true,
            },
          ],
        }
      )
    );
  }

  // ==========================================
  // 4. PARTIAL CONTENT BLUR & TRUNCATION GATES (25 cases)
  // ==========================================
  const blurPhrases = [
    'Content blurred because an adblocker is active',
    'Remaining paragraphs hidden: turn off adblock to unblur',
    'Adblock detected: reading mode disabled',
  ];

  for (let i = 0; i < 25; i++) {
    const id = nextId();
    const split = getSplit(caseIdx);
    const blurPhrase = blurPhrases[i % blurPhrases.length] || '';

    cases.push(
      createCase(
        id,
        split,
        'partial-blur-gate',
        'css-blur-filter-gate',
        'ADAPT',
        'S3',
        ['DOM_REMOVE_OVERLAY', 'DOM_RESTORE_SCROLL'],
        ['NET_TEMP_BLOCK'],
        {
          candidateElements: [
            {
              ref: 'element:e1',
              role: 'blur-backdrop',
              viewportCoverage: 0.8,
              isFixedOrAbsolute: true,
              hasHighZIndex: true,
              textSignals: [blurPhrase, 'adblock', 'unblur'],
              interactionSuppressed: true,
            },
          ],
        }
      )
    );
  }

  // ==========================================
  // 5. BENIGN CONTROLS — COOKIE / GDPR (35 cases)
  // ==========================================
  const cookiePhrases = [
    'We use cookies to improve your browsing experience and personalize content',
    'Privacy notice and GDPR cookie settings',
    'This site uses cookies for analytics and security',
    'Review our cookie policy before proceeding',
  ];

  for (let i = 0; i < 35; i++) {
    const id = nextId();
    const split = getSplit(caseIdx);
    const phrase = cookiePhrases[i % cookiePhrases.length] || '';

    cases.push(
      createCase(
        id,
        split,
        'benign-control',
        'cookie-consent-gdpr',
        'ABSTAIN',
        'ABSTAIN',
        ['ABSTAIN'],
        ['DOM_REMOVE_OVERLAY', 'DOM_RESTORE_SCROLL'],
        {
          candidateElements: [
            {
              ref: 'element:e1',
              role: 'consent-banner',
              viewportCoverage: 0.15,
              isFixedOrAbsolute: true,
              hasHighZIndex: true,
              textSignals: [phrase, 'accept', 'decline', 'cookie preferences'],
              interactionSuppressed: false,
            },
          ],
        }
      )
    );
  }

  // ==========================================
  // 6. BENIGN CONTROLS — LOGIN & SUBSCRIBER (30 cases)
  // ==========================================
  const loginPhrases = [
    'Sign in to your account',
    'Subscriber login required to view private dashboard',
    'Enter your username and password',
    'Welcome back! Please authenticate',
    'Access denied: Sign in with corporate SSO',
  ];

  for (let i = 0; i < 30; i++) {
    const id = nextId();
    const split = getSplit(caseIdx);
    const phrase = loginPhrases[i % loginPhrases.length] || '';

    cases.push(
      createCase(
        id,
        split,
        'benign-control',
        'legitimate-login-modal',
        'ABSTAIN',
        'ABSTAIN',
        ['ABSTAIN'],
        ['DOM_REMOVE_OVERLAY', 'DOM_RESTORE_SCROLL'],
        {
          candidateElements: [
            {
              ref: 'element:e1',
              role: 'login-dialog',
              viewportCoverage: 0.4,
              isFixedOrAbsolute: true,
              hasHighZIndex: true,
              textSignals: [phrase, 'password', 'login', 'forgot password'],
              interactionSuppressed: true,
            },
          ],
        }
      )
    );
  }

  // ==========================================
  // 7. BENIGN CONTROLS — NEWSLETTERS & PROMOS (25 cases)
  // ==========================================
  const promoPhrases = [
    'Subscribe to our weekly newsletter for 20% off',
    'Join 50,000 engineers getting our tech updates',
    'Special summer sale! Enter your email',
    'Get top news stories delivered to your inbox',
  ];

  for (let i = 0; i < 25; i++) {
    const id = nextId();
    const split = getSplit(caseIdx);
    const phrase = promoPhrases[i % promoPhrases.length] || '';

    cases.push(
      createCase(
        id,
        split,
        'benign-control',
        'newsletter-signup-modal',
        'ABSTAIN',
        'ABSTAIN',
        ['ABSTAIN'],
        ['DOM_REMOVE_OVERLAY', 'DOM_RESTORE_SCROLL'],
        {
          candidateElements: [
            {
              ref: 'element:e1',
              role: 'newsletter-dialog',
              viewportCoverage: 0.35,
              isFixedOrAbsolute: true,
              hasHighZIndex: true,
              textSignals: [phrase, 'subscribe', 'no thanks', 'email address'],
              interactionSuppressed: false,
            },
          ],
        }
      )
    );
  }

  // ==========================================
  // 8. DIFFICULT HYBRID CASES & EDITORIALS (30 cases)
  // ==========================================
  const hybridPhrases = [
    'Article: How modern adblockers fight invasive anti-adblock detection scripts',
    'Research: The technical anatomy of Chrome Manifest V3 and ad blocker extensions',
    'Opinion: Why websites lose revenue to ad blocking technologies',
    'Tutorial: How to configure privacy tools and adblock extensions safely',
    'Documentation: Best practices for debugging content blocker rule collisions',
  ];

  for (let i = 0; i < 30; i++) {
    const id = nextId();
    const split = getSplit(caseIdx);
    const phrase = hybridPhrases[i % hybridPhrases.length] || '';

    cases.push(
      createCase(
        id,
        split,
        'benign-hybrid',
        'editorial-adblock-discussion',
        'ABSTAIN',
        'ABSTAIN',
        ['ABSTAIN'],
        ['DOM_REMOVE_OVERLAY', 'DOM_RESTORE_SCROLL', 'DOM_PRESERVE_BAIT'],
        {
          candidateElements: [
            {
              ref: 'element:e1',
              role: 'article-header',
              viewportCoverage: 0.1,
              isFixedOrAbsolute: false,
              hasHighZIndex: false,
              textSignals: [phrase, 'adblock', 'anti-adblock', 'manifest v3', 'filter list'],
              interactionSuppressed: false,
            },
          ],
        }
      )
    );
  }

  return cases;
}

const corpus = generateCorpus();
const outputPath = path.resolve(process.cwd(), 'tests/fixtures/ai/eval-corpus-v2.json');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(corpus, null, 2));

console.log(`Generated ${corpus.length} evaluation cases.`);
console.log(`Dev Set: ${corpus.filter((c) => c.split === 'dev').length} cases.`);
console.log(`Holdout Set: ${corpus.filter((c) => c.split === 'holdout').length} cases.`);
