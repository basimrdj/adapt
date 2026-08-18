import { describe, expect, it } from 'vitest';
import { classifyDetectorBaitSelector, parseFilterLists, renderGenericCosmeticCss } from '../../src/page/filtering/compiler';
import { matchesDomain } from '../../src/page/filtering/matching';

describe('Phase 3.1B page filter compiler', () => {
  it('classifies conservative detector-bait selectors and excludes them from static hiding', () => {
    expect(classifyDetectorBaitSelector('.ad-widget')).toBe('POSSIBLE_DETECTOR_BAIT');
    expect(classifyDetectorBaitSelector('#ads')).toBe('POSSIBLE_DETECTOR_BAIT');
    expect(classifyDetectorBaitSelector('.sponsored-card')).toBe('ORDINARY_COSMETIC');

    // FuckAdBlock v3/v4 canonical bait classes (all naming variants) must never be
    // hidden — they exist only as detection tripwires.
    for (const bait of ['.text-ad', '.textAd', '.text_ad', '.text_ads', '.text-ads', '.ad-text',
      '.pub_300x250', '.pub_300x250m', '.pub_728x90', '.adSense', '.adContent', '.adBanner',
      '.adsbox', '#adblock-detector', '.adsbygoogle']) {
      expect(classifyDetectorBaitSelector(bait), `bait ${bait}`).toBe('POSSIBLE_DETECTOR_BAIT');
    }
    // Real sponsored-content containers keep getting hidden (not in the decoy set).
    expect(classifyDetectorBaitSelector('.sponsored')).toBe('ORDINARY_COSMETIC');

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

  it('compiles the newly-audited interception and state scriptlets as early MAIN-world rules', () => {
    const bundle = parseFilterLists([
      {
        id: 31,
        text: [
          "example.com#%#//scriptlet('prevent-addEventListener', 'click', '/track/')",
          "example.com#%#//scriptlet('prevent-setInterval', '/ads/')",
          "example.com#%#//scriptlet('adjust-setInterval', '/ads/')",
          "example.com#%#//scriptlet('adjust-setTimeout', 'check', '1000', '0.1')",
          "example.com#%#//scriptlet('set-cookie', 'consent', 'yes')",
          "example.com#%#//scriptlet('set-local-storage-item', 'flag', 'false')",
          "example.com#%#//scriptlet('set-local-storage-item', 'stale', '$remove$')",
          "example.com#%#//scriptlet('set-session-storage-item', 'counter', '1')",
          "example.com#%#//scriptlet('prevent-element-src-loading', 'script', '/advert/')",
        ].join('\n'),
      },
    ]);

    for (const scriptlet of bundle.scriptlets) {
      expect(scriptlet.supported, `${scriptlet.name} should be supported`).toBe(true);
      expect(scriptlet.supportStatus, `${scriptlet.name} status`).toBe('fully-executable');
      expect(scriptlet.world).toBe('MAIN');
      expect(scriptlet.early, `${scriptlet.name} must run pre-page-script`).toBe(true);
    }
    expect(bundle.counts.fullyExecutable).toBe(9);
    expect(bundle.unsupported).toHaveLength(0);
  });

  it('rejects out-of-grammar arguments for the newly-audited scriptlets', () => {
    const bundle = parseFilterLists([
      {
        id: 32,
        text: [
          // boost outside (0, 1]
          "example.com#%#//scriptlet('adjust-setTimeout', 'check', '1000', '2')",
          // empty handler-source pattern
          "example.com#%#//scriptlet('adjust-setInterval', '')",
          // both patterns empty
          "example.com#%#//scriptlet('prevent-addEventListener', '', '')",
          // cookie name outside the RFC token grammar
          "example.com#%#//scriptlet('set-cookie', 'bad;name', 'x')",
          // cookie value with a separator
          "example.com#%#//scriptlet('set-cookie', 'consent', 'a b')",
          // function-typed magic value is meaningless as a stored string
          "example.com#%#//scriptlet('set-local-storage-item', 'flag', 'noopFunc')",
          // key outside the audited grammar
          "example.com#%#//scriptlet('set-session-storage-item', 'bad key', '1')",
          // tag outside the audited src-bearing set
          "example.com#%#//scriptlet('prevent-element-src-loading', 'div', '/x/')",
          // empty URL pattern
          "example.com#%#//scriptlet('prevent-element-src-loading', 'script', '')",
        ].join('\n'),
      },
    ]);

    expect(bundle.counts.fullyExecutable).toBe(0);
    const byName = bundle.scriptlets.map((scriptlet) => [scriptlet.name, scriptlet.supportStatus] as const);
    expect(byName).toEqual([
      ['adjust-setTimeout', 'unsupported-by-arguments'],
      ['adjust-setInterval', 'unsupported-by-arguments'],
      ['prevent-addEventListener', 'unsupported-by-arguments'],
      ['set-cookie', 'unsafe'],
      ['set-cookie', 'unsupported-by-arguments'],
      ['set-local-storage-item', 'unsupported-by-arguments'],
      ['set-session-storage-item', 'unsupported-by-arguments'],
      ['prevent-element-src-loading', 'unsupported-by-arguments'],
      ['prevent-element-src-loading', 'unsupported-by-arguments'],
    ]);
    expect(bundle.unsupported).toHaveLength(9);
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
