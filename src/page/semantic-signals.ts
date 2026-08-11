import { SemanticSignal } from '../shared/types';
import { DETECTOR_KEYWORDS } from '../shared/constants';

/**
 * Extracts semantic text signals associated with anti-adblock detection.
 */
export function extractSemanticSignals(): SemanticSignal {
  const detectedPhrases: string[] = [];
  const textContent = (document.body?.innerText || '').toLowerCase();

  if (!textContent || textContent.length === 0) {
    return {
      detectedPhrases: [],
      adblockKeywordDensity: 0,
      confidenceScore: 0,
    };
  }

  let totalMatches = 0;
  for (const keyword of DETECTOR_KEYWORDS) {
    if (textContent.includes(keyword)) {
      detectedPhrases.push(keyword);
      totalMatches++;
    }
  }

  // Check for benign consent / newsletter modal negative controls
  const isCookieConsent =
    textContent.includes('cookie') ||
    textContent.includes('privacy policy') ||
    textContent.includes('accept all cookies');

  const isNewsletter =
    textContent.includes('subscribe to our newsletter') ||
    textContent.includes('enter your email');

  let confidenceScore = Math.min(1, detectedPhrases.length * 0.35);

  // If strictly a cookie banner or newsletter without strong adblock keywords, reduce confidence
  if ((isCookieConsent || isNewsletter) && detectedPhrases.length <= 1) {
    confidenceScore = Math.max(0, confidenceScore - 0.4);
  }

  const wordCount = Math.max(1, textContent.split(/\s+/).length);
  const adblockKeywordDensity = totalMatches / wordCount;

  return {
    detectedPhrases,
    adblockKeywordDensity,
    confidenceScore,
  };
}
