export type PageRuleKind = 'css' | 'has-text' | 'matches-css' | 'remove' | 'remove-attr';

export type DetectorBaitClassification =
  | 'ORDINARY_COSMETIC'
  | 'POSSIBLE_DETECTOR_BAIT'
  | 'CONFIRMED_DETECTOR_BAIT';

export type ScriptletWorld = 'ISOLATED' | 'MAIN';

export type ScriptletLifecycle =
  | 'ONE_SHOT_MAIN_WORLD'
  | 'PERSISTENT_MAIN_WORLD'
  | 'REAPPLY_ON_MUTATION'
  | 'REAPPLY_ON_NAVIGATION'
  | 'ELEMENT_SCOPED';

export type ScriptletSupportStatus =
  | 'fully-executable'
  | 'unsupported-by-name'
  | 'unsupported-by-arguments'
  | 'unsafe';

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
  detectorBait: DetectorBaitClassification;
}

export interface ScriptletRule {
  id: string;
  name: string;
  args: string[];
  domains: string[];
  excludedDomains: string[];
  world: ScriptletWorld;
  supported: boolean;
  lifecycle: ScriptletLifecycle;
  supportStatus: ScriptletSupportStatus;
  supportReason?: string;
  early: boolean;
  sourceFilterId: number;
}

export interface PageFilterBundle {
  schemaVersion: number;
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
    parsed: number;
    fullyExecutable: number;
    fullyExecutableEarly: number;
    unsupportedByName: number;
    unsupportedByArguments: number;
    unsafe: number;
    exceptionSuppressed: number;
    possibleDetectorBait: number;
    confirmedDetectorBait: number;
  };
}
