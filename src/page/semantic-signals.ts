import { SemanticSignal } from '../shared/types';
import { DETECTOR_KEYWORDS } from '../shared/constants';
import { hashOrigin } from '../shared/causal/events';

/**
 * Extracts semantic text signals associated with anti-adblock detection.
 */
export function extractSemanticSignals(): SemanticSignal {
  const detectedPhrases: string[] = [];
  const categories = new Set<NonNullable<SemanticSignal['categories']>[number]>();
  const textContent = (document.body?.innerText || '').toLowerCase();

  if (!textContent || textContent.length === 0) {
    return {
      detectedPhrases: [],
      categories: [],
      featureHash: hashOrigin('none'),
      adblockKeywordDensity: 0,
      confidenceScore: 0,
    };
  }

  let totalMatches = 0;
  for (const keyword of DETECTOR_KEYWORDS) {
    if (textContent.includes(keyword)) {
      categories.add('ANTI_BLOCK_INSTRUCTION');
      totalMatches++;
    }
  }

  if (/(support|fund|keep)\s+(this|the)\s+(site|content)/.test(textContent)) {
    categories.add('AD_REVENUE_APPEAL');
  }
  if (/(play|watch|stream|video).{0,48}(blocked|unavailable|enable|allow)/.test(textContent)) {
    categories.add('PLAYBACK_GATE');
  }
  if (/(click|tap|interact).{0,48}(denied|disabled|blocked|continue)/.test(textContent)) {
    categories.add('INTERACTION_DENIAL');
  }

  // Check for benign consent / newsletter modal negative controls
  const isCookieConsent =
    textContent.includes('cookie') ||
    textContent.includes('privacy policy') ||
    textContent.includes('accept all cookies');

  const isNewsletter =
    textContent.includes('subscribe to our newsletter') ||
    textContent.includes('enter your email');

  let confidenceScore = Math.min(1, totalMatches * 0.35);

  // If strictly a cookie banner or newsletter without strong adblock keywords, reduce confidence
  if ((isCookieConsent || isNewsletter) && totalMatches <= 1) {
    confidenceScore = Math.max(0, confidenceScore - 0.4);
  }

  if (isCookieConsent) categories.add('BENIGN_CONSENT');
  if (isNewsletter) categories.add('BENIGN_NEWSLETTER');
  if (/(sign in|log in|login)/.test(textContent)) categories.add('BENIGN_LOGIN');
  if (/(subscribe|membership|premium).{0,48}(read|continue|access)/.test(textContent)) {
    categories.add('BENIGN_PAYWALL');
  }

  if (categories.has('ANTI_BLOCK_INSTRUCTION')) {
    detectedPhrases.push('ANTI_BLOCK_INSTRUCTION');
  }
  if (categories.has('AD_REVENUE_APPEAL')) detectedPhrases.push('AD_REVENUE_APPEAL');
  if (categories.has('PLAYBACK_GATE')) detectedPhrases.push('PLAYBACK_GATE');
  if (categories.has('INTERACTION_DENIAL')) detectedPhrases.push('INTERACTION_DENIAL');

  const wordCount = Math.max(1, textContent.split(/\s+/).length);
  const adblockKeywordDensity = totalMatches / wordCount;

  return {
    detectedPhrases,
    categories: [...categories],
    featureHash: hashOrigin([...categories].sort().join('|') || 'none'),
    adblockKeywordDensity,
    confidenceScore,
  };
}
