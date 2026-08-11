import { StrategyAction, NetBlockAction, NetAllowAction, NetRedirectAction } from '../../shared/types';
import { getPriority, PriorityBand } from './priorities';

export interface CompiledDnrRule {
  rule: chrome.declarativeNetRequest.Rule;
  isUnsafe: boolean;
  isRegex: boolean;
}

export class DnrCompiler {
  /**
   * Compiles an array of network actions into Declarative Net Request rules.
   */
  public compileAction(
    action: StrategyAction,
    id: number,
    priorityBand: PriorityBand,
    options?: {
      tabId?: number;
      initiatorDomains?: string[];
      excludedInitiatorDomains?: string[];
    }
  ): CompiledDnrRule | null {
    if (action.type === 'NET_BLOCK') {
      return this.compileBlock(action as NetBlockAction, id, priorityBand, options);
    }
    if (action.type === 'NET_ALLOW_EXCEPTION') {
      return this.compileAllow(action as NetAllowAction, id, priorityBand, options);
    }
    if (action.type === 'NET_REDIRECT_LOCAL') {
      return this.compileRedirect(action as NetRedirectAction, id, priorityBand, options);
    }
    return null;
  }

  private compileBlock(
    action: NetBlockAction,
    id: number,
    priorityBand: PriorityBand,
    options?: {
      tabId?: number;
      initiatorDomains?: string[];
      excludedInitiatorDomains?: string[];
    }
  ): CompiledDnrRule {
    const defaultResourceTypes: chrome.declarativeNetRequest.ResourceType[] = [
      'script' as chrome.declarativeNetRequest.ResourceType,
      'image' as chrome.declarativeNetRequest.ResourceType,
      'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
      'sub_frame' as chrome.declarativeNetRequest.ResourceType,
      'ping' as chrome.declarativeNetRequest.ResourceType,
    ];

    const condition: chrome.declarativeNetRequest.RuleCondition = {
      resourceTypes: action.resourceTypes || defaultResourceTypes,
    };

    if (action.isRegex) {
      condition.regexFilter = action.urlFilter;
    } else {
      condition.urlFilter = action.urlFilter;
    }

    if (options?.tabId !== undefined) {
      condition.tabIds = [options.tabId];
    }
    if (options?.initiatorDomains && options.initiatorDomains.length > 0) {
      condition.initiatorDomains = options.initiatorDomains;
    }
    if (options?.excludedInitiatorDomains && options.excludedInitiatorDomains.length > 0) {
      condition.excludedInitiatorDomains = options.excludedInitiatorDomains;
    }

    return {
      rule: {
        id,
        priority: getPriority(priorityBand),
        action: {
          type: 'block' as chrome.declarativeNetRequest.RuleActionType,
        },
        condition,
      },
      isUnsafe: false,
      isRegex: Boolean(action.isRegex),
    };
  }

  private compileAllow(
    action: NetAllowAction,
    id: number,
    priorityBand: PriorityBand,
    options?: {
      tabId?: number;
      initiatorDomains?: string[];
    }
  ): CompiledDnrRule {
    const defaultResourceTypes: chrome.declarativeNetRequest.ResourceType[] = [
      'script' as chrome.declarativeNetRequest.ResourceType,
      'image' as chrome.declarativeNetRequest.ResourceType,
      'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
      'sub_frame' as chrome.declarativeNetRequest.ResourceType,
    ];

    const condition: chrome.declarativeNetRequest.RuleCondition = {
      urlFilter: action.urlFilter,
      resourceTypes: action.resourceTypes || defaultResourceTypes,
    };

    if (options?.tabId !== undefined) {
      condition.tabIds = [options.tabId];
    }
    if (options?.initiatorDomains) {
      condition.initiatorDomains = options.initiatorDomains;
    }

    return {
      rule: {
        id,
        priority: getPriority(priorityBand),
        action: {
          type: 'allow' as chrome.declarativeNetRequest.RuleActionType,
        },
        condition,
      },
      isUnsafe: false,
      isRegex: false,
    };
  }

  private compileRedirect(
    action: NetRedirectAction,
    id: number,
    priorityBand: PriorityBand,
    options?: {
      tabId?: number;
      initiatorDomains?: string[];
    }
  ): CompiledDnrRule {
    const condition: chrome.declarativeNetRequest.RuleCondition = {
      urlFilter: action.urlFilter,
      resourceTypes: [
        'script' as chrome.declarativeNetRequest.ResourceType,
        'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
        'image' as chrome.declarativeNetRequest.ResourceType,
      ],
    };

    if (options?.tabId !== undefined) {
      condition.tabIds = [options.tabId];
    }
    if (options?.initiatorDomains) {
      condition.initiatorDomains = options.initiatorDomains;
    }

    return {
      rule: {
        id,
        priority: getPriority(priorityBand),
        action: {
          type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
          redirect: {
            extensionPath: action.extensionPath,
          },
        },
        condition,
      },
      isUnsafe: true,
      isRegex: false,
    };
  }
}
