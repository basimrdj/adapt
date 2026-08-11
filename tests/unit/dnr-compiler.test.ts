import { describe, it, expect } from 'vitest';
import { DnrCompiler } from '../../src/core/dnr/compiler';
import { NetBlockAction, NetAllowAction, NetRedirectAction } from '../../src/shared/types';
import { PRIORITIES } from '../../src/shared/constants';

describe('DnrCompiler', () => {
  const compiler = new DnrCompiler();

  it('compiles NET_BLOCK action correctly with tabId scoping', () => {
    const action: NetBlockAction = {
      id: 'act_1',
      type: 'NET_BLOCK',
      urlFilter: '||ads.example.com^',
      resourceTypes: [
        'script' as chrome.declarativeNetRequest.ResourceType,
        'image' as chrome.declarativeNetRequest.ResourceType,
      ],
    };

    const compiled = compiler.compileAction(action, 3000001, 'EXPERIMENT_BLOCK', { tabId: 42 });
    expect(compiled).not.toBeNull();
    expect(compiled?.rule.id).toBe(3000001);
    expect(compiled?.rule.priority).toBe(PRIORITIES.EXPERIMENT_BLOCK);
    expect(compiled?.rule.action.type).toBe('block');
    expect(compiled?.rule.condition.urlFilter).toBe('||ads.example.com^');
    expect(compiled?.rule.condition.tabIds).toEqual([42]);
    expect(compiled?.isUnsafe).toBe(false);
  });

  it('compiles NET_ALLOW_EXCEPTION correctly', () => {
    const action: NetAllowAction = {
      id: 'act_2',
      type: 'NET_ALLOW_EXCEPTION',
      urlFilter: '||probe.example.com^',
    };

    const compiled = compiler.compileAction(action, 3000002, 'COMPATIBILITY_EXCEPTION', { tabId: 10 });
    expect(compiled?.rule.action.type).toBe('allow');
    expect(compiled?.rule.priority).toBe(PRIORITIES.COMPATIBILITY_EXCEPTION);
    expect(compiled?.isUnsafe).toBe(false);
  });

  it('compiles NET_REDIRECT_LOCAL action correctly as unsafe rule', () => {
    const action: NetRedirectAction = {
      id: 'act_3',
      type: 'NET_REDIRECT_LOCAL',
      urlFilter: '||ad-service.com/lib.js',
      extensionPath: '/stubs/noop.js',
    };

    const compiled = compiler.compileAction(action, 4000001, 'EXPERIMENT_REDIRECT', { tabId: 5 });
    expect(compiled?.rule.action.type).toBe('redirect');
    expect(compiled?.rule.action.redirect?.extensionPath).toBe('/stubs/noop.js');
    expect(compiled?.isUnsafe).toBe(true);
  });
});
