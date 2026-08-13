export type PageRuleKind = 'css' | 'has-text' | 'matches-css' | 'remove' | 'remove-attr';

export type ScriptletWorld = 'ISOLATED' | 'MAIN';

export interface PageFilterRule {
  id: string;
  kind: PageRuleKind;
  selector: string;
  argument?: string;
  property?: string;
  value?: string;
  domains: string[];
  excludedDomains: string[];
  sourceFilterId: number;
}

export interface ScriptletRule {
  id: string;
  name: string;
  args: string[];
  domains: string[];
  excludedDomains: string[];
  world: ScriptletWorld;
  supported: boolean;
  sourceFilterId: number;
}

export interface PageFilterBundle {
  schemaVersion: 1;
  generatedAt: string;
  genericRules: PageFilterRule[];
  domainRules: PageFilterRule[];
  scriptlets: ScriptletRule[];
  exceptions: Array<{
    selector: string;
    domains: string[];
    excludedDomains: string[];
    scriptletName?: string;
    scriptletArgs?: string[];
    sourceFilterId: number;
  }>;
  unsupported: Array<{
    kind: 'cosmetic' | 'scriptlet';
    sourceFilterId: number;
    line: string;
    reason: string;
  }>;
  counts: {
    cosmetic: number;
    generic: number;
    domainSpecific: number;
    exceptions: number;
    scriptlets: number;
    supportedScriptlets: number;
    unsupported: number;
  };
}
