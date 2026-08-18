import { AdaptationTransaction } from '../../shared/types';
import { DnrController } from '../dnr/controller';

export class AdaptationRollbackHandler {
  private dnrController: DnrController;
  private sendTabMessage: (tabId: number, msg: unknown) => Promise<void>;

  constructor(
    dnrController: DnrController,
    sendTabMessage: (tabId: number, msg: unknown) => Promise<void>
  ) {
    this.dnrController = dnrController;
    this.sendTabMessage = sendTabMessage;
  }

  public async rollback(tx: AdaptationTransaction): Promise<{
    sessionRulesRemoved: boolean;
    domActionsRolledBack: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    let sessionRulesRemoved = false;
    let domActionsRolledBack = 0;

    // 1. Remove staged session rules (guaranteed attempt)
    if (tx.sessionRuleIds.length > 0) {
      try {
        await this.dnrController.removeSessionExperimentRules(tx.sessionRuleIds, 'adaptation-rollback');
        sessionRulesRemoved = true;
      } catch (err: unknown) {
        errors.push(`DNR rollback error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      sessionRulesRemoved = true;
    }

    // 2. Rollback staged DOM actions in content script (guaranteed attempt for all)
    for (const actionId of tx.domActionIds) {
      try {
        await this.sendTabMessage(tx.tabId, {
          v: 1,
          type: 'ROLLBACK_DOM_ACTION',
          txId: tx.txId,
          actionId,
          documentId: tx.documentId,
        });
        domActionsRolledBack++;
      } catch (err: unknown) {
        // Tab might be closed or refreshed
        errors.push(`DOM action ${actionId} rollback skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      sessionRulesRemoved,
      domActionsRolledBack,
      errors,
    };
  }
}
