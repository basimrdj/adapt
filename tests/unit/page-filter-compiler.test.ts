import { describe, expect, it } from 'vitest';
import { classifyDetectorBaitSelector, parseFilterLists, renderGenericCosmeticCss } from '../../src/page/filtering/compiler';
import { matchesDomain } from '../../src/page/filtering/matching';

describe('Phase 3.1B page filter compiler', () => {
  it('classifies conservative detector-bait selectors and excludes them from static hiding', () => {
    expect(classifyDetectorBaitSelector('.ad-widget')).toBe('POSSIBLE_DETECTOR_BAIT');
    expect(classifyDetectorBaitSelector('#ads')).toBe('POSSIBLE_DETECTOR_BAIT');
    expect(classifyDetectorBaitSelector('.sponsored-card')).toBe('ORDINARY_COSMETIC');

    const bundle = parseFilterLists([{ id: 7, text: '##.ad-widget\n##.ordinary-card\n' }]);
    expect(bundle.counts.possibleDetectorBait).toBe(1);
    expect(renderGenericCosmeticCss(bundle)).toContain('.ordinary-card');
    expect(renderGenericCosmeticCss(bundle)).not.toContain('.ad-widget');
  });

  it('keeps generic, domain-specific, and exception semantics separate', () => {
    const bundle = parseFilterLists([
      {
        id: 2,
        text: [
          '##.generic-ad',
          'example.com##.site-ad',
          'example.com#@#.site-ad',
          '#@#.generic-ad',
        ].join('\n'),
      },
    ]);

    expect(bundle.genericRules.map((rule) => rule.selector)).toEqual(['.generic-ad']);
    expect(bundle.domainRules.map((rule) => rule.selector)).toEqual(['.site-ad']);
    expect(bundle.exceptions).toEqual([
      expect.objectContaining({ selector: '.site-ad', domains: ['example.com'] }),
      expect.objectContaining({ selector: '.generic-ad', domains: [] }),
    ]);
  });

  it('parses audited scriptlets and records unsupported primitives', () => {
    const bundle = parseFilterLists([
      {
        id: 19,
        text: [
          "example.com#%#//scriptlet('set-constant', 'google_ad_status', '1')",
          "example.com#%#//scriptlet('remove-attr', 'data-ad', '.slot')",
          "example.com#%#//scriptlet('abort-on-property-read', 'adsBlocked')",
        ].join('\n'),
      },
    ]);

    expect(bundle.scriptlets).toEqual([
      expect.objectContaining({ name: 'set-constant', args: ['google_ad_status', '1'], world: 'MAIN', supported: true }),
      expect.objectContaining({ name: 'remove-attr', args: ['data-ad', '.slot'], world: 'ISOLATED', supported: true }),
      expect.objectContaining({ name: 'abort-on-property-read', world: 'MAIN', supported: true, supportStatus: 'fully-executable' }),
    ]);
    expect(bundle.counts.supportedScriptlets).toBe(3);
    expect(bundle.counts.fullyExecutable).toBe(3);
    expect(bundle.counts.unsupportedByName).toBe(0);
    expect(bundle.unsupported).toHaveLength(0);
  });

  it('accepts bounded procedural CSS and rejects unsafe primitives', () => {
    const bundle = parseFilterLists([
      {
        id: 2,
        text: [
          'example.com##.card:has-text(Advertisement)',
          'example.com##.slot:matches-css(display, none)',
          'example.com##.target:remove',
          'example.com##.bad:xpath(//script)',
        ].join('\n'),
      },
    ]);

    expect(bundle.domainRules.map((rule) => rule.kind)).toEqual(['has-text', 'matches-css', 'remove']);
    expect(bundle.unsupported[0]?.reason).toContain('unsupported');
  });

  it('matches subdomains while respecting exclusions', () => {
    expect(matchesDomain('www.example.com', ['example.com'], [])).toBe(true);
    expect(matchesDomain('cdn.example.com', ['example.com'], ['cdn.example.com'])).toBe(false);
    expect(matchesDomain('other.test', [], [])).toBe(true);
  });

  it('counts only complete descriptors and separates runtime from early execution', () => {
    const bundle = parseFilterLists([
      {
        id: 7,
        text: [
          "example.com#%#//scriptlet('abort-on-property-read', 'detector')",
          "example.com#%#//scriptlet('prevent-fetch', 'ads.example')",
          "example.com#%#//scriptlet('set-constant', 'detector', 'unsupported-value')",
          "example.com#@%#//scriptlet('prevent-fetch', 'ads.example')",
        ].join('\n'),
      },
    ]);

    expect(bundle.scriptlets).toEqual([
      expect.objectContaining({ name: 'abort-on-property-read', supported: true, early: true }),
      expect.objectContaining({ name: 'prevent-fetch', supported: true, early: false }),
      expect.objectContaining({ name: 'set-constant', supported: false, supportStatus: 'unsupported-by-arguments', early: false }),
    ]);
    expect(bundle.counts.parsed).toBe(4);
    expect(bundle.counts.fullyExecutable).toBe(2);
    expect(bundle.counts.fullyExecutableEarly).toBe(1);
    expect(bundle.counts.unsupportedByArguments).toBe(1);
    expect(bundle.counts.exceptionSuppressed).toBe(1);
  });
});
