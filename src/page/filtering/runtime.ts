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

  public init(): void {
    this.attachObserver();
    window.addEventListener('popstate', () => this.scheduleApply());
    window.addEventListener('hashchange', () => this.scheduleApply());
    this.scheduleApply();
    void this.loadGenericCss();
    void this.loadBundle();
  }

  private async loadGenericCss(): Promise<void> {
    try {
      const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest;
      const hasStaticPageCss = manifest.content_scripts?.some((entry) =>
        Array.isArray(entry.css) && entry.css.includes('phase31-page-cosmetic.css')
      );
      if (hasStaticPageCss) return;
      if (typeof __ADAPT_GENERIC_CSS__ === 'string' && __ADAPT_GENERIC_CSS__) {
        this.appendGenericCss(__ADAPT_GENERIC_CSS__);
        return;
      }
      const response = await fetch(chrome.runtime.getURL('phase31-page-cosmetic.css'), { cache: 'no-store' });
      if (!response.ok) return;
      const css = await response.text();
      if (!css) return;
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

  private async loadBundle(): Promise<void> {
    try {
      const response = await fetch(chrome.runtime.getURL('page-filtering/index.json'), { cache: 'no-store' });
      if (!response.ok) return;
      const value: unknown = await response.json();
      if (!this.isBundle(value)) return;
      this.bundle = value;
      this.scheduleApply();
    } catch {
      return;
    }
  }

  private isBundle(value: unknown): value is PageFilterBundle {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<PageFilterBundle>;
    return candidate.schemaVersion === 1 && Array.isArray(candidate.genericRules) && Array.isArray(candidate.domainRules) && Array.isArray(candidate.scriptlets) && Array.isArray(candidate.exceptions);
  }

  private attachObserver(): void {
    try {
      this.observer?.disconnect();
      this.observer = new MutationObserver((mutations) => {
        this.mutationCount += mutations.length;
        const elapsed = Date.now() - this.windowStart;
        if (elapsed > 1000) {
          if (this.mutationCount > 1000) this.degradedUntil = Date.now() + 2000;
          this.mutationCount = 0;
          this.windowStart = Date.now();
        }
        this.scheduleApply();
      });
      const target = document.documentElement || document;
      this.observer.observe(target, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
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
    const genericWithExceptions = this.bundle.genericRules.filter((rule) =>
      rule.kind !== 'css' || this.bundle?.exceptions.some((exception) => !exception.scriptletName && exception.selector === rule.selector)
    );
    const allRules = [...genericWithExceptions, ...this.bundle.domainRules.filter((rule) => matchesDomain(hostname, rule.domains, rule.excludedDomains))];
    const active = allRules.filter((rule) => !exceptionMatches(hostname, rule.selector, this.bundle?.exceptions || []));
    const css = active.filter((rule) => rule.kind === 'css' && safeSelector(rule.selector));
    const procedural = active.filter((rule) => rule.kind !== 'css');
    const scriptlets = this.bundle.scriptlets.filter((rule) => rule.supported && matchesDomain(hostname, rule.domains, rule.excludedDomains) && !scriptletExceptionMatches(hostname, rule.name, rule.args, this.bundle?.exceptions || []) && !this.appliedScriptlets.has(rule.id));
    return { css, procedural, scriptlets };
  }

  private apply(): void {
    if (this.applying || !this.bundle) return;
    this.applying = true;
    try {
      const hostname = window.location.hostname.toLowerCase();
      const active = this.activeRules(hostname);
      this.applyCss(active.css);
      for (const rule of active.procedural.slice(0, 800)) {
        if (rule.kind === 'css') continue;
        applyProceduralRule(rule.kind, rule.selector, rule.argument, rule.property, rule.value);
      }
      for (const scriptlet of active.scriptlets.slice(0, 200)) {
        const result = scriptlet.world === 'ISOLATED' ? applyIsolatedScriptlet(scriptlet.name, scriptlet.args) : 'skipped';
        if (result !== 'skipped') this.appliedScriptlets.add(scriptlet.id);
        if (scriptlet.world === 'MAIN') this.requestMainScriptlet(scriptlet);
      }
    } catch {
      return;
    } finally {
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
