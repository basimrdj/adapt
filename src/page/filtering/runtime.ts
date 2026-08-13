import { exceptionMatches, matchesDomain, scriptletExceptionMatches } from './matching';
import { applyIsolatedScriptlet, applyProceduralRule } from './scriptlets';
import { PageFilterBundle, PageFilterRule, ScriptletRule } from './types';

declare const __ADAPT_GENERIC_CSS__: string;

interface MainScriptletMessage {
  v: 1;
  type: 'PAGE_FILTER_MAIN_SCRIPTLET';
  ruleId: string;
  name: string;
  args: string[];
}

interface PageFilterIndex {
  schemaVersion: number;
  genericArtifact?: string;
  domainIndexArtifact?: string;
  counts?: PageFilterBundle['counts'];
}

interface PageFilterShardData {
  genericRules?: PageFilterRule[];
  domainRules?: PageFilterRule[];
  scriptlets?: ScriptletRule[];
  exceptions?: PageFilterBundle['exceptions'];
}

type PageFilterShard = Record<string, PageFilterShardData>;

interface PageFilterMetrics {
  loadedArtifacts: string[];
  loadedBytes: number;
  candidateDomainKeys: string[];
  mutationBatches: number;
  proceduralEvaluations: number;
  scriptletExecutions: number;
  lastApplyMs: number;
}

declare global {
  interface Window {
    __adaptPageFilterMetrics?: PageFilterMetrics;
  }
}

function safeSelector(selector: string): boolean {
  if (!selector || selector.length > 1000) return false;
  if (/[{};]/.test(selector)) return false;
  try {
    document.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

function domainCandidates(hostname: string): string[] {
  const labels = hostname.toLowerCase().split('.').filter(Boolean);
  const candidates: string[] = [];
  for (let index = 0; index < labels.length - 1; index++) candidates.push(labels.slice(index).join('.'));
  return [...new Set(candidates)];
}

function createMetrics(): PageFilterMetrics {
  return { loadedArtifacts: [], loadedBytes: 0, candidateDomainKeys: [], mutationBatches: 0, proceduralEvaluations: 0, scriptletExecutions: 0, lastApplyMs: 0 };
}

export class PageFilteringRuntime {
  private bundle: PageFilterBundle | null = null;
  private styleElement: HTMLStyleElement | null = null;
  private observer: MutationObserver | null = null;
  private scheduled = false;
  private applying = false;
  private mutationCount = 0;
  private windowStart = Date.now();
  private degradedUntil = 0;
  private appliedScriptlets = new Set<string>();
  private appliedCssText = '';
  private navigationKey = '';
  private readonly metrics = createMetrics();
  private readonly genericExceptionSelectors = new Set<string>();
  private readonly scriptletExceptions = new Set<string>();

  public init(): void {
    window.__adaptPageFilterMetrics = this.metrics;
    this.attachObserver();
    window.addEventListener('popstate', () => this.handleNavigation());
    window.addEventListener('hashchange', () => this.handleNavigation());
    this.scheduleApply();
    void this.loadGenericCss();
    void this.loadBundle();
  }

  private handleNavigation(): void {
    const nextKey = `${window.location.href}`;
    if (nextKey === this.navigationKey) return;
    this.navigationKey = nextKey;
    for (const rule of this.bundle?.scriptlets || []) {
      if (rule.lifecycle === 'REAPPLY_ON_NAVIGATION') this.appliedScriptlets.delete(rule.id);
    }
    this.scheduleApply();
  }

  private async loadGenericCss(): Promise<void> {
    try {
      const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest;
      const hasStaticPageCss = manifest.content_scripts?.some((entry) => Array.isArray(entry.css) && entry.css.includes('phase31-page-cosmetic.css'));
      if (hasStaticPageCss) return;
      if (typeof __ADAPT_GENERIC_CSS__ === 'string' && __ADAPT_GENERIC_CSS__) {
        this.appendGenericCss(__ADAPT_GENERIC_CSS__);
        return;
      }
      const response = await fetch(chrome.runtime.getURL('phase31-page-cosmetic.css'), { cache: 'no-store' });
      if (!response.ok) return;
      const css = await response.text();
      if (!css) return;
      this.metrics.loadedBytes += css.length;
      this.appendGenericCss(css);
    } catch {
      return;
    }
  }

  private appendGenericCss(css: string): void {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement || document).appendChild(style);
  }

  private async fetchJson<T>(resource: string): Promise<T | null> {
    const response = await fetch(chrome.runtime.getURL(resource), { cache: 'no-store' });
    if (!response.ok) return null;
    const text = await response.text();
    this.metrics.loadedBytes += text.length;
    this.metrics.loadedArtifacts.push(resource);
    return JSON.parse(text) as T;
  }

  private async loadBundle(): Promise<void> {
    try {
      const index = await this.fetchJson<PageFilterIndex | PageFilterBundle>('page-filtering/index.json');
      if (!index) return;
      if (this.isBundle(index)) {
        this.bundle = index;
      } else if (index.schemaVersion >= 3 && index.genericArtifact && index.domainIndexArtifact) {
        const generic = await this.fetchJson<PageFilterShardData>(`page-filtering/${index.genericArtifact}`);
        const domainIndex = await this.fetchJson<Record<string, string>>(`page-filtering/${index.domainIndexArtifact}`);
        if (!generic || !domainIndex) return;
        const keys = domainCandidates(window.location.hostname);
        this.metrics.candidateDomainKeys = keys;
        const shards = await Promise.all([...new Set(keys.map((key) => domainIndex[key]).filter(Boolean))].map((resource) => this.fetchJson<PageFilterShard>(`page-filtering/${resource}`)));
        const selected: PageFilterShardData[] = [];
        for (const key of keys) {
          for (const shard of shards) {
            const entry = shard?.[key];
            if (entry) selected.push(entry);
          }
        }
        const domainRules = [...new Map(selected.flatMap((shard) => shard.domainRules || []).map((rule) => [rule.id, rule])).values()];
        const scriptlets = [...new Map(selected.flatMap((shard) => shard.scriptlets || []).map((rule) => [rule.id, rule])).values()];
        const exceptions = [...new Map([...(generic.exceptions || []), ...selected.flatMap((shard) => shard.exceptions || [])].map((exception) => [`${exception.selector}|${exception.scriptletName || ''}|${JSON.stringify(exception.scriptletArgs || [])}|${exception.sourceFilterId}`, exception])).values()];
        const genericRules = generic.genericRules || [];
        this.bundle = {
          schemaVersion: 2,
          generatedAt: new Date().toISOString(),
          genericRules,
          domainRules,
          scriptlets: [...(generic.scriptlets || []), ...scriptlets],
          exceptions,
          unsupported: [],
          counts: index.counts || {
            cosmetic: genericRules.length + domainRules.length,
            generic: genericRules.length,
            domainSpecific: domainRules.length,
            exceptions: exceptions.length,
            scriptlets: scriptlets.length,
            supportedScriptlets: scriptlets.filter((rule) => rule.supported).length,
            unsupported: 0,
            parsed: scriptlets.length,
            fullyExecutable: scriptlets.filter((rule) => rule.supported).length,
            unsupportedByName: 0,
            unsupportedByArguments: 0,
            unsafe: 0,
            exceptionSuppressed: exceptions.filter((exception) => Boolean(exception.scriptletName)).length,
          },
        };
      } else {
        return;
      }
      this.rebuildExceptionIndexes();
      this.scheduleApply();
    } catch {
      return;
    }
  }

  private rebuildExceptionIndexes(): void {
    this.genericExceptionSelectors.clear();
    this.scriptletExceptions.clear();
    for (const exception of this.bundle?.exceptions || []) {
      if (exception.scriptletName) this.scriptletExceptions.add(`${exception.scriptletName}|${JSON.stringify(exception.scriptletArgs || [])}`);
      else if (exception.selector) this.genericExceptionSelectors.add(exception.selector);
    }
  }

  private isBundle(value: unknown): value is PageFilterBundle {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<PageFilterBundle>;
    return (candidate.schemaVersion === 1 || candidate.schemaVersion === 2) && Array.isArray(candidate.genericRules) && Array.isArray(candidate.domainRules) && Array.isArray(candidate.scriptlets) && Array.isArray(candidate.exceptions);
  }

  private attachObserver(): void {
    try {
      this.observer?.disconnect();
      this.observer = new MutationObserver((mutations) => {
        this.metrics.mutationBatches += 1;
        this.mutationCount += mutations.length;
        const elapsed = Date.now() - this.windowStart;
        if (elapsed > 1000) {
          if (this.mutationCount > 1000) this.degradedUntil = Date.now() + 2000;
          this.mutationCount = 0;
          this.windowStart = Date.now();
        }
        this.scheduleApply();
      });
      this.observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    } catch {
      this.observer = null;
    }
  }

  private scheduleApply(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const delay = Date.now() < this.degradedUntil ? 250 : 50;
    window.setTimeout(() => {
      this.scheduled = false;
      this.apply();
    }, delay);
  }

  private activeRules(hostname: string): { css: PageFilterRule[]; procedural: PageFilterRule[]; scriptlets: ScriptletRule[] } {
    if (!this.bundle) return { css: [], procedural: [], scriptlets: [] };
    const allRules = [
      ...this.bundle.genericRules,
      ...this.bundle.domainRules.filter((rule) => matchesDomain(hostname, rule.domains, rule.excludedDomains)),
    ];
    const active = allRules.filter((rule) => !exceptionMatches(hostname, rule.selector, this.bundle?.exceptions || []));
    const css = active.filter((rule) => rule.kind === 'css' && safeSelector(rule.selector));
    const procedural = active.filter((rule) => rule.kind !== 'css');
    const scriptlets = this.bundle.scriptlets.filter((rule) => {
      if (!rule.supported || !matchesDomain(hostname, rule.domains, rule.excludedDomains)) return false;
      if (this.scriptletExceptions.has(`${rule.name}|${JSON.stringify(rule.args)}`) && scriptletExceptionMatches(hostname, rule.name, rule.args, this.bundle?.exceptions || [])) return false;
      if (rule.lifecycle === 'REAPPLY_ON_MUTATION') return true;
      return !this.appliedScriptlets.has(rule.id);
    });
    return { css, procedural, scriptlets };
  }

  private apply(): void {
    if (this.applying || !this.bundle) return;
    this.applying = true;
    const startedAt = performance.now();
    try {
      const hostname = window.location.hostname.toLowerCase();
      const active = this.activeRules(hostname);
      this.applyCss(active.css);
      for (const rule of active.procedural.slice(0, 800)) {
        if (rule.kind === 'css') continue;
        this.metrics.proceduralEvaluations += 1;
        applyProceduralRule(rule.kind, rule.selector, rule.argument, rule.property, rule.value);
      }
      for (const scriptlet of active.scriptlets.slice(0, 200)) {
        const result = scriptlet.world === 'ISOLATED' ? applyIsolatedScriptlet(scriptlet.name, scriptlet.args) : 'skipped';
        if (result !== 'skipped') this.metrics.scriptletExecutions += 1;
        if (scriptlet.lifecycle !== 'REAPPLY_ON_MUTATION' && (result !== 'skipped' || scriptlet.world === 'MAIN')) this.appliedScriptlets.add(scriptlet.id);
        if (scriptlet.world === 'MAIN') this.requestMainScriptlet(scriptlet);
      }
    } catch {
      return;
    } finally {
      this.metrics.lastApplyMs = performance.now() - startedAt;
      this.applying = false;
    }
  }

  private applyCss(rules: PageFilterRule[]): void {
    const css = rules.map((rule) => `${rule.selector}{display:none!important;}`).join('\n');
    if (rules.length === 0 && !this.styleElement) return;
    if (this.styleElement?.isConnected && css === this.appliedCssText) return;
    if (!this.styleElement || !this.styleElement.isConnected) {
      this.styleElement = document.createElement('style');
      this.styleElement.appendChild(document.createTextNode(''));
      (document.head || document.documentElement || document).appendChild(this.styleElement);
    }
    this.styleElement.textContent = css;
    this.appliedCssText = css;
  }

  private requestMainScriptlet(scriptlet: ScriptletRule): void {
    const message: MainScriptletMessage = { v: 1, type: 'PAGE_FILTER_MAIN_SCRIPTLET', ruleId: scriptlet.id, name: scriptlet.name, args: scriptlet.args };
    chrome.runtime.sendMessage(message).then(() => this.appliedScriptlets.add(scriptlet.id)).catch(() => undefined);
  }
}
