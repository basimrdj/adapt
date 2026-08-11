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

  public async rollback(tx: AdaptationTransaction): Promise<void> {
    // 1. Remove staged session rules
    if (tx.sessionRuleIds.length > 0) {
      await this.dnrController.removeSessionExperimentRules(tx.sessionRuleIds);
    }

    // 2. Rollback staged DOM actions in content script
    for (const actionId of tx.domActionIds) {
      try {
        await this.sendTabMessage(tx.tabId, {
          v: 1,
          type: 'ROLLBACK_DOM_ACTION',
          txId: tx.txId,
          actionId,
        });
      } catch {
        // Tab might be closed or refreshed
      }
    }
  }
}
