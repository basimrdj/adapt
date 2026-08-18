import {
  OpaqueElementObservation,
  OpaqueSurvivorObservation,
  PageSignalBatch,
  ResourceAssociationObservation,
  SurvivorClass,
  SemanticSignal,
} from '../shared/types';
import { hashOrigin, OpaqueRef } from '../shared/causal/events';
import { isProtectedFlowHost } from '../shared/protected-flows';
import { isThirdPartyResource, resourceIdentity } from '../shared/resource-identity';
import { safeGetBoundingClientRect, safeGetComputedStyle } from './dom-safety';
import { OpaqueTargetRegistry } from './opaque-targets';

const RESOURCE_SELECTORS = 'iframe[src],iframe, img[src],img, script[src], object[data], embed[src], video[src], audio[src], source[src]';
const SURFACE_SELECTORS = '[data-ad-slot], [aria-label*="sponsor" i], [aria-label*="advert" i], [class*="sponsor" i], [class*="advert" i], [id*="ad-" i], [class*="ad-" i]';
const AD_LABEL = /(^|[-_\s])(ad|ads|advert|advertisement|sponsor|sponsored|promoted|promotion)([-_\s]|$)/i;
const PROTECTED_CONTEXT = /(login|sign[ -]?in|oauth|checkout|payment|purchase|download|document|player|video|audio|media|captcha|consent|cookie|newsletter|paywall)/i;

interface LocalCandidate {
  element: HTMLElement;
  resourceHash?: string;
  resourceType?: string;
  thirdParty: boolean;
  visible: boolean;
  fixedOrAbsolute: boolean;
  isolatedSurface: boolean;
  semanticAdLabel: boolean;
  recentInsertion: boolean;
  viewportCoverage: number;
  protectedContext: OpaqueSurvivorObservation['protectedContext'];
}

function resourceTypeFor(element: HTMLElement): string {
  switch (element.tagName.toLowerCase()) {
    case 'iframe': return 'sub_frame';
    case 'script': return 'script';
    case 'img': return 'image';
    case 'video':
    case 'audio':
    case 'source': return 'media';
    case 'object':
    case 'embed': return 'object';
    default: return 'other';
  }
}

function resourceUrlFor(element: HTMLElement): string | null {
  if (element instanceof HTMLImageElement) return element.currentSrc || element.src || null;
  if (element instanceof HTMLScriptElement) return element.src || null;
  if (element instanceof HTMLIFrameElement) return element.src || null;
  if (element instanceof HTMLObjectElement) return element.data || null;
  if (element instanceof HTMLEmbedElement) return element.src || null;
  if (element instanceof HTMLMediaElement) return element.currentSrc || element.src || null;
  if (element instanceof HTMLSourceElement) return element.src || null;
  return element.getAttribute('src') || element.getAttribute('data') || null;
}

function featureText(element: HTMLElement): string {
  return [
    element.id,
    typeof element.className === 'string' ? element.className : '',
    element.getAttribute('aria-label') || '',
    element.getAttribute('title') || '',
    element.getAttribute('alt') || '',
  ].join(' ');
}

function isVisible(element: HTMLElement, rect: DOMRect): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = safeGetComputedStyle(element);
  if (!style) return false;
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0.01;
}

function protectedContext(element: HTMLElement, resourceUrl: string | null): OpaqueSurvivorObservation['protectedContext'] {
  const feature = `${featureText(element)} ${resourceUrl || ''}`;
  const media = ['VIDEO', 'AUDIO', 'SOURCE'].includes(element.tagName) || /player|video|audio|media/i.test(feature);
  // Keyword features catch login/payment ELEMENTS; the host registry catches
  // elements whose RESOURCE lives on a protected-flow host (sign-in JS CDN,
  // captcha provider, payment SDK) even when the element text is innocuous.
  let protectedResource = false;
  if (resourceUrl) {
    try {
      protectedResource = isProtectedFlowHost(new URL(resourceUrl, window.location.href).hostname);
    } catch {
      protectedResource = false;
    }
  }
  const authOrPayment = protectedResource || /(login|sign[ -]?in|oauth|checkout|payment|purchase|captcha)/i.test(feature);
  const downloadOrDocument = /(download|document|\.pdf\b|\.docx?\b)/i.test(feature);
  return { authOrPayment, media, downloadOrDocument, userIntentRelated: PROTECTED_CONTEXT.test(feature) };
}

function localCandidate(
  element: HTMLElement,
  seen: WeakSet<HTMLElement>
): LocalCandidate | null {
  const rect = safeGetBoundingClientRect(element);
  if (!rect) return null;
  const visible = isVisible(element, rect);
  const style = safeGetComputedStyle(element);
  if (!style) return null;
  const resourceUrl = resourceUrlFor(element);
  const identity = resourceUrl ? resourceIdentity(resourceUrl, window.location.href) : null;
  const thirdParty = resourceUrl ? isThirdPartyResource(resourceUrl, window.location.origin) : false;
  const text = featureText(element);
  const explicitSurface = element.matches(SURFACE_SELECTORS);
  const semanticAdLabel = explicitSurface || AD_LABEL.test(text);
  const fixedOrAbsolute = ['fixed', 'sticky', 'absolute'].includes(style.position);
  const isolatedSurface = element.tagName === 'IFRAME' || fixedOrAbsolute || Number(style.zIndex || '0') > 10;
  const coverage = Math.max(0, Math.min(1, (rect.width * rect.height) / Math.max(1, window.innerWidth * window.innerHeight)));
  const protectedFlags = protectedContext(element, resourceUrl);
  if (!visible || protectedFlags.authOrPayment || protectedFlags.media || protectedFlags.downloadOrDocument) return null;
  return {
    element,
    resourceHash: identity?.hash,
    resourceType: resourceTypeFor(element),
    thirdParty,
    visible,
    fixedOrAbsolute,
    isolatedSurface,
    semanticAdLabel,
    recentInsertion: !seen.has(element),
    viewportCoverage: coverage,
    protectedContext: protectedFlags,
  };
}

function classFor(candidate: LocalCandidate): SurvivorClass {
  if (candidate.element.tagName === 'IFRAME' && candidate.thirdParty) return 'THIRD_PARTY_AD_FRAME';
  if (candidate.recentInsertion && candidate.semanticAdLabel) return 'REINSERTED_SURFACE';
  if (candidate.semanticAdLabel) return 'PROMOTIONAL_SURFACE';
  return 'VISIBLE_AD_SURFACE';
}

function candidateConfidence(candidate: LocalCandidate): number {
  let score = 0;
  if (candidate.thirdParty) score += 0.25;
  if (candidate.visible) score += 0.2;
  if (candidate.element.tagName === 'IFRAME') score += 0.2;
  if (candidate.fixedOrAbsolute) score += 0.15;
  if (candidate.isolatedSurface) score += 0.1;
  if (candidate.semanticAdLabel) score += 0.15;
  if (candidate.recentInsertion) score += 0.05;
  return Math.min(0.99, score);
}

export class SurvivorDiscoveryEngine {
  private readonly survivorRefs = new WeakMap<HTMLElement, `survivor:s${number}`>();
  private readonly seenElements = new WeakSet<HTMLElement>();
  private nextSurvivor = 1;

  constructor(
    private readonly navigationId: string,
    private readonly targets: OpaqueTargetRegistry
  ) {}

  observe(
    semantic: SemanticSignal,
    pageSignals: PageSignalBatch,
    existingElements: OpaqueElementObservation[]
  ): { survivors: OpaqueSurvivorObservation[]; resourceAssociations: ResourceAssociationObservation[] } {
    const resourceAssociations: ResourceAssociationObservation[] = [];
    const survivors: OpaqueSurvivorObservation[] = [];
    const candidates: LocalCandidate[] = [];
    const elements = Array.from(document.querySelectorAll<HTMLElement>(RESOURCE_SELECTORS)).slice(0, 120);
    const surfaces = Array.from(document.querySelectorAll<HTMLElement>(SURFACE_SELECTORS)).slice(0, 80);
    for (const element of [...elements, ...surfaces]) {
      const candidate = localCandidate(element, this.seenElements);
      this.seenElements.add(element);
      if (!candidate) continue;
      candidates.push(candidate);
      if (candidate.resourceHash) {
        const elementRef = this.targets.register(element);
        resourceAssociations.push({
          elementRef,
          resourceIdentityHash: candidate.resourceHash,
          resourceType: candidate.resourceType || 'other',
          thirdPartyResource: candidate.thirdParty,
          visible: candidate.visible,
        });
      }
    }

    for (const element of existingElements.filter((item) => item.role === 'semantic-reaction-ui' && item.visible)) {
      const survivorRef = `survivor:s${this.nextSurvivor++}` as const;
      survivors.push({
        ref: survivorRef,
        class: 'ANTI_BLOCK_REACTION',
        documentScope: this.navigationId,
        observedAt: Date.now(),
        confidence: Math.max(0.75, semantic.confidenceScore),
        evidenceClasses: ['semantic-category', 'opaque-reaction-container'],
        elementRef: element.ref,
        protectedContext: { authOrPayment: false, media: false, downloadOrDocument: false, userIntentRelated: false },
        features: {
          visible: true,
          thirdPartyResource: false,
          fixedOrAbsolute: true,
          isolatedSurface: true,
          semanticAdLabel: false,
          recentInsertion: pageSignals.mutation.rapidReinsertionDetected,
          mutationAssociation: pageSignals.mutation.rapidReinsertionDetected ? 0.8 : 0.4,
          viewportCoverage: element.viewportCoverage,
        },
      });
    }

    // Hard-detector bridge: the compact-notice heuristics that mint
    // 'semantic-reaction-ui' deliberately exclude viewport-sized surfaces, so a
    // detector that blocks with a FULLSCREEN wall (the aggressive end of the
    // spectrum) would never reach the survivor-AI gate. When the page-level
    // semantic scan has already classified the text as an anti-block
    // instruction, a visible fullscreen overlay IS the reaction surface.
    if ((semantic.categories ?? []).includes('ANTI_BLOCK_INSTRUCTION') && semantic.confidenceScore >= 0.5) {
      for (const element of existingElements.filter((item) => item.role === 'fullscreen-overlay' && item.visible)) {
        const survivorRef = `survivor:s${this.nextSurvivor++}` as const;
        survivors.push({
          ref: survivorRef,
          class: 'ANTI_BLOCK_REACTION',
          documentScope: this.navigationId,
          observedAt: Date.now(),
          confidence: Math.max(0.8, semantic.confidenceScore),
          evidenceClasses: ['semantic-category', 'fullscreen-reaction-wall'],
          elementRef: element.ref,
          protectedContext: { authOrPayment: false, media: false, downloadOrDocument: false, userIntentRelated: false },
          features: {
            visible: true,
            thirdPartyResource: false,
            fixedOrAbsolute: true,
            isolatedSurface: true,
            semanticAdLabel: false,
            recentInsertion: pageSignals.mutation.rapidReinsertionDetected,
            mutationAssociation: pageSignals.mutation.rapidReinsertionDetected ? 0.9 : 0.5,
            viewportCoverage: element.viewportCoverage,
          },
        });
      }
    }

    for (const candidate of candidates
      .map((item) => ({ item, confidence: candidateConfidence(item) }))
      .filter((item) => item.confidence >= 0.6)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 12)) {
      const elementRef = this.targets.register(candidate.item.element);
      const existing = this.survivorRefs.get(candidate.item.element);
      const survivorRef = existing || (`survivor:s${this.nextSurvivor++}` as const);
      this.survivorRefs.set(candidate.item.element, survivorRef);
      const evidenceClasses = ['visible', 'third-party-or-isolated'];
      if (candidate.item.semanticAdLabel) evidenceClasses.push('local-promotional-semantics');
      if (candidate.item.fixedOrAbsolute) evidenceClasses.push('positioned-surface');
      if (candidate.item.recentInsertion) evidenceClasses.push('recent-insertion');
      survivors.push({
        ref: survivorRef,
        class: classFor(candidate.item),
        documentScope: this.navigationId,
        observedAt: Date.now(),
        confidence: candidate.confidence,
        evidenceClasses,
        elementRef,
        resourceIdentityHash: candidate.item.resourceHash,
        resourceType: candidate.item.resourceType,
        protectedContext: candidate.item.protectedContext,
        features: {
          visible: candidate.item.visible,
          thirdPartyResource: candidate.item.thirdParty,
          fixedOrAbsolute: candidate.item.fixedOrAbsolute,
          isolatedSurface: candidate.item.isolatedSurface,
          semanticAdLabel: candidate.item.semanticAdLabel,
          recentInsertion: candidate.item.recentInsertion,
          mutationAssociation: pageSignals.mutation.rapidReinsertionDetected ? 0.7 : candidate.item.recentInsertion ? 0.5 : 0.2,
          viewportCoverage: candidate.item.viewportCoverage,
        },
      });
    }

    if (semantic.categories?.includes('PLAYBACK_GATE') && survivors.length === 0) {
      survivors.push({
        ref: `survivor:s${this.nextSurvivor++}`,
        class: 'PLAYER_OBSTRUCTION',
        documentScope: this.navigationId,
        observedAt: Date.now(),
        confidence: semantic.confidenceScore,
        evidenceClasses: ['playback-gate'],
        protectedContext: { authOrPayment: false, media: true, downloadOrDocument: false, userIntentRelated: true },
        features: {
          visible: true,
          thirdPartyResource: false,
          fixedOrAbsolute: false,
          isolatedSurface: false,
          semanticAdLabel: false,
          recentInsertion: false,
          mutationAssociation: 0.3,
          viewportCoverage: 0,
        },
      });
    }

    return { survivors, resourceAssociations };
  }
}

export function survivorRefFromOpaqueRefs(refs: readonly OpaqueRef[]): `survivor:s${number}` | undefined {
  return refs.find((ref): ref is `survivor:s${number}` => ref.startsWith('survivor:s'));
}

export function survivorFeatureHash(observation: OpaqueSurvivorObservation): string {
  return hashOrigin([
    observation.class,
    observation.resourceIdentityHash || 'none',
    observation.features.thirdPartyResource ? 'third-party' : 'first-party',
    observation.protectedContext.media ? 'media' : 'non-media',
  ].join('|'));
}
