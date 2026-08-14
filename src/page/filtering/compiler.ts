import { createHash } from 'node:crypto';
import {
  PageFilterBundle,
  PageFilterRule,
  PageRuleKind,
  DetectorBaitClassification,
  ScriptletLifecycle,
  ScriptletRule,
  ScriptletSupportStatus,
  ScriptletWorld,
} from './types';

export interface FilterSource {
  id: number;
  text: string;
}

interface DomainScope {
  domains: string[];
  excludedDomains: string[];
}

interface ScriptletValidation {
  world: ScriptletWorld;
  lifecycle: ScriptletLifecycle;
  early: boolean;
  status: ScriptletSupportStatus;
  reason?: string;
}

const UNSUPPORTED_COSMETIC_MARKERS = [
  ':xpath(',
  ':upward(',
  ':watch-attr(',
  ':contains(',
  ':-abp-',
  ':style(',
];

const UNSAFE_PATH_ROOTS = new Set([
  'Array',
  'Atomics',
  'BigInt',
  'Boolean',
  'Date',
  'Document',
  'Error',
  'Function',
  'JSON',
  'Math',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'Reflect',
  'RegExp',
  'String',
  'Symbol',
  'Uint8Array',
  'Window',
  'chrome',
  'document',
  'globalThis',
  'location',
  'navigator',
  'window',
]);

const SCRIPTLET_NAMES = new Set([
  'abort-current-inline-script',
  'abort-on-property-read',
  'abort-on-property-write',
  'abort-on-stack-trace',
  'adjust-setInterval',
  'adjust-setTimeout',
  'json-prune',
  'json-prune-xhr-response',
  'prevent-addEventListener',
  'prevent-eval-if',
  'prevent-fetch',
  'prevent-setTimeout',
  'prevent-window-open',
  'prevent-xhr',
  'remove-attr',
  'remove-class',
  'remove-node-attr',
  'remove-node-text',
  'set-constant',
  'set-cookie',
  'set-local-storage-item',
  'trusted-suppress-native-method',
]);

const EXECUTABLE_SCRIPTLETS = new Set([
  'abort-current-inline-script',
  'abort-on-property-read',
  'abort-on-property-write',
  'json-prune',
  'prevent-eval-if',
  'prevent-fetch',
  'prevent-setTimeout',
  'prevent-window-open',
  'prevent-xhr',
  'remove-attr',
  'remove-class',
  'remove-node-attr',
  'remove-node-text',
  'set-constant',
]);

const EARLY_SCRIPTLETS = new Set([
  'set-constant',
  'abort-current-inline-script',
  'abort-on-property-read',
  'abort-on-property-write',
  'prevent-setTimeout',
  'prevent-eval-if',
  'json-prune',
]);

const DETECTOR_BAIT_EXACT_NAMES = new Set([
  'ad',
  'ads',
  'adblock',
  'ad-banner',
  'ad-box',
  'ad-container',
  'ad-placeholder',
  'ad-slot',
  'ad-space',
  'ad-widget',
  'ad-wrapper',
  'advertisement',
  'adsbox',
  'banner-ad',
]);

const DETECTOR_BAIT_ROLE_WORDS = new Set([
  'banner',
  'block',
  'box',
  'container',
  'placeholder',
  'slot',
  'space',
  'widget',
  'wrapper',
]);

function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function classifyDetectorBaitSelector(selector: string): DetectorBaitClassification {
  const match = selector.trim().match(/^[.#]([A-Za-z][A-Za-z0-9_-]*)$/);
  if (!match) return 'ORDINARY_COSMETIC';

  const name = match[1]!.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  if (DETECTOR_BAIT_EXACT_NAMES.has(name)) return 'POSSIBLE_DETECTOR_BAIT';

  const words = name.split(/[-_]+/).filter(Boolean);
  const hasAdWord = words.some((word) => word === 'ad' || word === 'ads' || word === 'advert' || word === 'advertisement');
  const hasRoleWord = words.some((word) => DETECTOR_BAIT_ROLE_WORDS.has(word));
  return hasAdWord && hasRoleWord && words.length <= 5 ? 'POSSIBLE_DETECTOR_BAIT' : 'ORDINARY_COSMETIC';
}

function splitDomains(value: string): DomainScope {
  const domains: string[] = [];
  const excludedDomains: string[] = [];

  for (const rawDomain of value.split(',')) {
    const domain = rawDomain.trim().toLowerCase();
    if (!domain) continue;
    if (domain.startsWith('~')) {
      if (/^[~][a-z0-9.*-]+$/.test(domain)) excludedDomains.push(domain.slice(1));
      continue;
    }
    if (/^[a-z0-9.*-]+$/.test(domain)) domains.push(domain);
  }

  return { domains: [...new Set(domains)], excludedDomains: [...new Set(excludedDomains)] };
}

function parseQuotedArguments(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return null;

  const args: string[] = [];
  let current = '';
  let quote = '';
  let escaped = false;

  for (let index = 1; index < trimmed.length - 1; index++) {
    const char = trimmed[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ',') {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  if (quote || escaped) return null;
  if (current.trim() || trimmed.length > 2) args.push(current.trim());
  return args;
}

function parseScriptlet(value: string): { name: string; args: string[] } | null {
  const match = value.match(/^\/\/scriptlet\s*([\s\S]*)$/i);
  if (!match) return null;
  const parsed = parseQuotedArguments(match[1] || '');
  const name = parsed?.[0];
  if (!name || !/^[\w-]+$/.test(name)) return null;
  return { name, args: parsed.slice(1) };
}

function isSafePath(value: string): boolean {
  const segments = value.split('.');
  if (segments.length === 0 || segments.length > 8) return false;
  if (!segments.every((segment) => /^[A-Za-z_$][\w$]{0,63}$/.test(segment))) return false;
  if (segments.some((segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) return false;
  return !UNSAFE_PATH_ROOTS.has(segments[0] ?? '');
}

function isBoundedPattern(value: string): boolean {
  if (value.length > 500) return false;
  if (value.startsWith('/') && value.endsWith('/')) {
    try {
      new RegExp(value.slice(1, -1));
      return true;
    } catch {
      return false;
    }
  }
  return !/[\u0000\n\r]/.test(value);
}

function isConstantValue(value: string): boolean {
  if (value === '' || /^(undefined|null|true|false|noopFunc|noopCallbackFunc|noopPromiseResolve|noopPromiseReject|trueFunc|falseFunc|emptyObj|emptyArray|emptyArr)$/.test(value)) return true;
  return /^-?\d{1,6}(?:\.\d{1,3})?$/.test(value);
}

function validateScriptlet(name: string, args: string[], scope: DomainScope): ScriptletValidation {
  if (!SCRIPTLET_NAMES.has(name)) {
    return { world: 'ISOLATED', lifecycle: 'ELEMENT_SCOPED', early: false, status: 'unsupported-by-name', reason: `scriptlet '${name}' is not in the audited primitive registry` };
  }

  if (args.some((arg) => arg.length > 1000 || /[\u0000]/.test(arg))) {
    return { world: 'ISOLATED', lifecycle: 'ELEMENT_SCOPED', early: false, status: 'unsafe', reason: 'argument contains an unsafe or oversized value' };
  }

  const isolated = name === 'remove-attr' || name === 'remove-class' || name === 'remove-node-attr' || name === 'remove-node-text';
  const world: ScriptletWorld = isolated ? 'ISOLATED' : 'MAIN';
  const lifecycle: ScriptletLifecycle = isolated ? 'REAPPLY_ON_MUTATION' : name === 'set-constant' ? 'PERSISTENT_MAIN_WORLD' : 'ONE_SHOT_MAIN_WORLD';
  const early = world === 'MAIN' && scope.domains.length > 0 && EARLY_SCRIPTLETS.has(name);

  if (!EXECUTABLE_SCRIPTLETS.has(name)) {
    return { world, lifecycle, early: false, status: 'unsupported-by-name', reason: `scriptlet '${name}' is known but not implemented in the audited runtime` };
  }

  const unsupportedArguments = (reason: string): ScriptletValidation => ({ world, lifecycle, early: false, status: 'unsupported-by-arguments', reason });
  const unsafe = (reason: string): ScriptletValidation => ({ world, lifecycle, early: false, status: 'unsafe', reason });

  if (name === 'set-constant') {
    if (args.length < 2 || args.length > 5) return unsupportedArguments('set-constant requires 2-5 arguments');
    const propertyPath = args[0] ?? '';
    const value = args[1] ?? '';
    if (!isSafePath(propertyPath)) return unsafe('set-constant property path is outside the safe grammar');
    if (!isConstantValue(value)) return unsupportedArguments('set-constant value is outside the audited value grammar');
    const modifiers = args.slice(2).filter(Boolean);
    if (modifiers.some((modifier) => !['asFunction', 'asResolved', 'true', 'false'].includes(modifier))) return unsupportedArguments('set-constant modifier is not supported');
    return { world, lifecycle, early, status: 'fully-executable' };
  }

  if (name === 'remove-attr' || name === 'remove-class') {
    if (args.length < 1 || args.length > 3) return unsupportedArguments(`${name} requires 1-3 arguments`);
    const attributeOrClass = args[0] ?? '';
    if (attributeOrClass.length > 100 || !/^[A-Za-z_][\w:-]{0,100}(?:\|[A-Za-z_][\w:-]{0,100})*$/.test(attributeOrClass)) return unsupportedArguments(`${name} attribute/class grammar is unsupported`);
    if (args[1] && (args[1].length > 1000 || /[{};]/.test(args[1]))) return unsafe(`${name} selector is unsafe`);
    return { world, lifecycle, early: false, status: 'fully-executable' };
  }

  if (name === 'remove-node-attr') {
    if (args.length !== 2 || !isBoundedPattern(args[0] ?? '') || !/^[A-Za-z_][\w:-]{0,100}$/.test(args[1] ?? '')) return unsupportedArguments('remove-node-attr requires selector and safe attribute');
    return { world, lifecycle, early: false, status: 'fully-executable' };
  }

  if (name === 'remove-node-text') {
    if (args.length < 2 || args.length > 3 || !isBoundedPattern(args[0] ?? '') || !isBoundedPattern(args[1] ?? '')) return unsupportedArguments('remove-node-text requires bounded selector and text/regex');
    return { world, lifecycle, early: false, status: 'fully-executable' };
  }

  if (name === 'abort-on-property-read' || name === 'abort-on-property-write') {
    if (args.length !== 1 || !isSafePath(args[0] ?? '')) return unsafe(`${name} requires a safe property path`);
    return { world, lifecycle, early, status: 'fully-executable' };
  }

  if (name === 'abort-current-inline-script') {
    if (args.length < 1 || args.length > 2 || !isBoundedPattern(args[0] ?? '') || (args[1] && !isBoundedPattern(args[1]))) return unsupportedArguments('abort-current-inline-script requires bounded property and optional source pattern');
    return { world, lifecycle, early, status: 'fully-executable' };
  }

  if (name === 'prevent-fetch' || name === 'prevent-xhr') {
    if (args.length < 1 || args.length > 3 || !isBoundedPattern(args[0] ?? '') || args.slice(1).some((arg) => arg && !isBoundedPattern(arg))) return unsupportedArguments(`${name} arguments must be bounded URL/method patterns`);
    return { world, lifecycle, early, status: 'fully-executable' };
  }

  if (name === 'prevent-setTimeout' || name === 'prevent-eval-if' || name === 'prevent-window-open') {
    if (args.length > (name === 'prevent-window-open' ? 3 : 2) || args.some((arg) => arg && !isBoundedPattern(arg))) return unsupportedArguments(`${name} arguments must be bounded patterns`);
    return { world, lifecycle, early, status: 'fully-executable' };
  }

  if (name === 'json-prune') {
    if (args.length < 1 || args.length > 3 || args.some((arg) => arg && !/^[A-Za-z0-9_.$*| -]{0,300}$/.test(arg))) return unsupportedArguments('json-prune paths must use the bounded property grammar');
    return { world, lifecycle, early, status: 'fully-executable' };
  }

  return unsupportedArguments('descriptor is not covered by an audited execution schema');
}

function classifyCosmeticSelector(selector: string): {
  kind: PageRuleKind;
  selector: string;
  detectorBait: DetectorBaitClassification;
  argument?: string;
  property?: string;
  value?: string;
} | null {
  const trimmed = selector.trim();
  if (!trimmed || trimmed.length > 1000) return null;
  if (UNSUPPORTED_COSMETIC_MARKERS.some((marker) => trimmed.includes(marker))) return null;

  const hasText = trimmed.match(/^(.*):has-text\((['"]?)(.*?)\2\)$/i);
  if (hasText) {
    const target = hasText[1] || '*';
    return { kind: 'has-text', selector: target, detectorBait: classifyDetectorBaitSelector(target), argument: hasText[3] };
  }

  const matchesCss = trimmed.match(/^(.*):matches-css\(([^,]+),\s*(.*?)\)$/i);
  if (matchesCss) {
    const property = matchesCss[2];
    const value = matchesCss[3];
    if (!property || value === undefined) return null;
    const target = matchesCss[1] || '*';
    return { kind: 'matches-css', selector: target, detectorBait: classifyDetectorBaitSelector(target), property: property.trim(), value: value.trim() };
  }

  if (trimmed.endsWith(':remove')) {
    const target = trimmed.slice(0, -7).trim() || '*';
    return { kind: 'remove', selector: target, detectorBait: classifyDetectorBaitSelector(target) };
  }

  const removeAttr = trimmed.match(/^(.*):remove-attr\(([^)]+)\)$/i);
  if (removeAttr) {
    const attribute = removeAttr[2];
    if (!attribute) return null;
    const target = removeAttr[1] || '*';
    return { kind: 'remove-attr', selector: target, detectorBait: classifyDetectorBaitSelector(target), argument: attribute.trim() };
  }

  if (trimmed.includes(':')) {
    const safePseudo = /:(?:is|where|not|has|first-child|last-child|nth-child|nth-of-type|empty|root|checked|disabled|enabled|visited|target|focus|hover|active|before|after)(?:\(|$)/i;
    const customPseudo = trimmed.match(/:([a-z-]+)(?:\(|$)/gi) || [];
    if (customPseudo.some((pseudo) => !safePseudo.test(pseudo))) return null;
  }

  return { kind: 'css', selector: trimmed, detectorBait: classifyDetectorBaitSelector(trimmed) };
}

function addUnique<T extends { id: string }>(target: T[], value: T): void {
  if (!target.some((existing) => existing.id === value.id)) target.push(value);
}

function makeRule(sourceId: number, scope: DomainScope, parsed: NonNullable<ReturnType<typeof classifyCosmeticSelector>>, line: string): PageFilterRule {
  return { id: stableId(`${sourceId}|cosmetic|${line}`), ...parsed, domains: scope.domains, excludedDomains: scope.excludedDomains, sourceFilterId: sourceId };
}

function makeScriptlet(sourceId: number, scope: DomainScope, parsed: { name: string; args: string[] }, line: string): ScriptletRule {
  const validation = validateScriptlet(parsed.name, parsed.args, scope);
  return {
    id: stableId(`${sourceId}|scriptlet|${line}`),
    name: parsed.name,
    args: parsed.args,
    domains: scope.domains,
    excludedDomains: scope.excludedDomains,
    world: validation.world,
    supported: validation.status === 'fully-executable',
    lifecycle: validation.lifecycle,
    supportStatus: validation.status,
    supportReason: validation.reason,
    early: validation.early,
    sourceFilterId: sourceId,
  };
}

export function parseFilterLists(sources: FilterSource[], generatedAt = new Date().toISOString()): PageFilterBundle {
  const genericRules: PageFilterRule[] = [];
  const domainRules: PageFilterRule[] = [];
  const scriptlets: ScriptletRule[] = [];
  const exceptions: PageFilterBundle['exceptions'] = [];
  const unsupported: PageFilterBundle['unsupported'] = [];

  for (const source of sources) {
    for (const rawLine of source.text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('!') || line.startsWith('[')) continue;

      const scriptletExceptionIndex = line.indexOf('#@%#');
      const scriptletIndex = line.indexOf('#%#');
      const cosmeticExceptionIndex = line.indexOf('#@#');
      const cosmeticIndex = line.indexOf('##');
      const extendedIndex = line.indexOf('#?#');

      if (scriptletExceptionIndex >= 0) {
        const scope = splitDomains(line.slice(0, scriptletExceptionIndex));
        const parsed = parseScriptlet(line.slice(scriptletExceptionIndex + 4));
        if (!parsed) unsupported.push({ kind: 'scriptlet', sourceFilterId: source.id, line, reason: 'invalid scriptlet exception syntax' });
        else {
          const validation = validateScriptlet(parsed.name, parsed.args, scope);
          if (validation.status === 'fully-executable') exceptions.push({ selector: '', ...scope, scriptletName: parsed.name, scriptletArgs: parsed.args, sourceFilterId: source.id });
          else unsupported.push({ kind: 'scriptlet', sourceFilterId: source.id, line, reason: `scriptlet exception is not compatible with the audited runtime: ${validation.reason || validation.status}` });
        }
        continue;
      }

      if (scriptletIndex >= 0 && (cosmeticIndex < 0 || scriptletIndex < cosmeticIndex)) {
        const scope = splitDomains(line.slice(0, scriptletIndex));
        const parsed = parseScriptlet(line.slice(scriptletIndex + 3));
        if (!parsed) {
          unsupported.push({ kind: 'scriptlet', sourceFilterId: source.id, line, reason: 'invalid or inline scriptlet syntax' });
          continue;
        }
        const scriptlet = makeScriptlet(source.id, scope, parsed, line);
        addUnique(scriptlets, scriptlet);
        if (!scriptlet.supported) unsupported.push({ kind: 'scriptlet', sourceFilterId: source.id, line, reason: scriptlet.supportReason || scriptlet.supportStatus });
        continue;
      }

      if (cosmeticExceptionIndex >= 0) {
        const scope = splitDomains(line.slice(0, cosmeticExceptionIndex));
        const selector = line.slice(cosmeticExceptionIndex + 3).trim();
        const parsed = parseScriptlet(selector);
        if (parsed) {
          const validation = validateScriptlet(parsed.name, parsed.args, scope);
          if (validation.status === 'fully-executable') exceptions.push({ selector: '', ...scope, scriptletName: parsed.name, scriptletArgs: parsed.args, sourceFilterId: source.id });
          else unsupported.push({ kind: 'scriptlet', sourceFilterId: source.id, line, reason: `scriptlet exception is not compatible with the audited runtime: ${validation.reason || validation.status}` });
        } else exceptions.push({ selector, ...scope, sourceFilterId: source.id });
        continue;
      }

      const markerIndex = extendedIndex >= 0 ? extendedIndex : cosmeticIndex;
      if (markerIndex < 0) continue;
      const scope = splitDomains(line.slice(0, markerIndex));
      const selector = line.slice(markerIndex + (extendedIndex >= 0 ? 3 : 2)).trim();
      const parsed = classifyCosmeticSelector(selector);
      if (!parsed) {
        unsupported.push({ kind: 'cosmetic', sourceFilterId: source.id, line, reason: 'selector requires an unsupported or unsafe procedural primitive' });
        continue;
      }
      const rule = makeRule(source.id, scope, parsed, line);
      if (scope.domains.length === 0) addUnique(genericRules, rule);
      else addUnique(domainRules, rule);
    }
  }

  const exceptionSuppressed = exceptions.filter((exception) => exception.scriptletName).length;
  const parsed = scriptlets.length + exceptionSuppressed;
  const fullyExecutable = scriptlets.filter((scriptlet) => scriptlet.supportStatus === 'fully-executable').length;
  const fullyExecutableEarly = scriptlets.filter((scriptlet) => scriptlet.supportStatus === 'fully-executable' && scriptlet.early).length;
  const unsupportedByName = scriptlets.filter((scriptlet) => scriptlet.supportStatus === 'unsupported-by-name').length;
  const unsupportedByArguments = scriptlets.filter((scriptlet) => scriptlet.supportStatus === 'unsupported-by-arguments').length;
  const unsafe = scriptlets.filter((scriptlet) => scriptlet.supportStatus === 'unsafe').length;
  const allCosmeticRules = [...genericRules, ...domainRules];
  const possibleDetectorBait = allCosmeticRules.filter((rule) => rule.detectorBait === 'POSSIBLE_DETECTOR_BAIT').length;
  const confirmedDetectorBait = allCosmeticRules.filter((rule) => rule.detectorBait === 'CONFIRMED_DETECTOR_BAIT').length;

  return {
    schemaVersion: 2,
    generatedAt,
    genericRules,
    domainRules,
    scriptlets,
    exceptions,
    unsupported,
    counts: {
      cosmetic: genericRules.length + domainRules.length,
      generic: genericRules.length,
      domainSpecific: domainRules.length,
      exceptions: exceptions.length,
      scriptlets: scriptlets.length,
      supportedScriptlets: fullyExecutable,
      unsupported: unsupported.length,
      parsed,
      fullyExecutable,
      fullyExecutableEarly,
      unsupportedByName,
      unsupportedByArguments,
      unsafe,
      exceptionSuppressed,
      possibleDetectorBait,
      confirmedDetectorBait,
    },
  };
}

export function renderGenericCosmeticCss(bundle: PageFilterBundle): string {
  const selectors = new Set<string>();
  for (const rule of bundle.genericRules) {
    if (rule.kind !== 'css' || rule.domains.length > 0 || rule.selector.length > 1000) continue;
    if (rule.detectorBait !== 'ORDINARY_COSMETIC') continue;
    if (/[{};]/.test(rule.selector)) continue;
    if (/:has-text\(|:matches-css\(|:xpath\(|:upward\(|:remove\b|:remove-attr\(/i.test(rule.selector)) continue;
    if (bundle.exceptions.some((exception) => !exception.scriptletName && exception.selector === rule.selector)) continue;
    selectors.add(rule.selector);
  }
  return [...selectors].slice(0, 20000).map((selector) => `${selector}{display:none!important;}`).join('\n');
}

export function scriptletCoverage(bundle: PageFilterBundle): PageFilterBundle['counts'] {
  return bundle.counts;
}
