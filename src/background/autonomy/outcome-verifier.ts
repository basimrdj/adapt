import { HealthVector } from '../../shared/types';
import { PrimitiveId } from './primitive-registry';

export interface PrimitiveOutcomeContext {
  targetClosed?: boolean;
  redirectStopped?: boolean;
  targetExists?: boolean;
  requestSuppressed?: boolean;
  requestSucceeded?: boolean;
  baitPreserved?: boolean;
  layoutRestored?: boolean;
  antiBlockReactionImproved?: boolean;
}

export interface PrimitiveOutcome {
  success: boolean;
  scoreDelta: number;
  notes: string;
}

function scoreDelta(before: HealthVector, after: HealthVector): number {
  return (
    (before.antiBlockReaction - after.antiBlockReaction) * 0.35
    + (after.contentAvailability - before.contentAvailability) * 0.25
    + (after.interaction - before.interaction) * 0.15
    + (before.visualObstruction - after.visualObstruction) * 0.1
    + (after.scrollability - before.scrollability) * 0.1
    + (after.navigationHealth - before.navigationHealth) * 0.05
  );
}

function safetyFloor(before: HealthVector, after: HealthVector): boolean {
  const contentSafe = after.contentAvailability >= before.contentAvailability - 0.05;
  const interactionSafe = after.interaction >= 0.7;
  const networkSafe = before.networkIntegrity === undefined
    || after.networkIntegrity === undefined
    || after.networkIntegrity >= before.networkIntegrity - 0.05;
  const privacySafe = before.privacyPreservation === undefined
    || after.privacyPreservation === undefined
    || after.privacyPreservation >= before.privacyPreservation - 0.01;
  return contentSafe && interactionSafe && networkSafe && privacySafe;
}

export class PrimitiveOutcomeVerifierRegistry {
  verify(
    primitiveId: PrimitiveId,
    before: HealthVector,
    after: HealthVector,
    context: PrimitiveOutcomeContext = {}
  ): PrimitiveOutcome {
    const safe = safetyFloor(before, after);
    let primitiveSuccess = false;
    let notes = 'primitive-specific outcome did not pass';

    switch (primitiveId) {
      case 'REMOVE_REACTION_UI':
        primitiveSuccess = (after.visualObstruction <= 0.2 || after.antiBlockReaction <= 0.2)
          && after.contentAvailability >= before.contentAvailability - 0.05
          && after.interaction >= 0.7
          && after.scrollability >= 0.7;
        notes = 'reaction UI removed while content and interaction remained healthy';
        break;
      case 'TOGGLE_COSMETIC_ACTION':
        primitiveSuccess = after.visualObstruction <= before.visualObstruction - 0.1
          && after.contentAvailability >= before.contentAvailability - 0.05;
        notes = 'cosmetic obstruction changed without content loss';
        break;
      case 'PRESERVE_BAIT':
        primitiveSuccess = context.baitPreserved === true
          && after.contentAvailability >= before.contentAvailability - 0.05;
        notes = 'detector bait remains measurable and page health is preserved';
        break;
      case 'RESTORE_LAYOUT':
        primitiveSuccess = context.layoutRestored === true
          && after.contentAvailability >= before.contentAvailability - 0.05;
        notes = 'content layout returned to its observed baseline';
        break;
      case 'RESTORE_SCROLL':
        primitiveSuccess = after.scrollability >= 0.7
          && after.scrollability >= before.scrollability + 0.1;
        notes = 'scrollability restored';
        break;
      case 'RESTORE_POINTER_INTERACTION':
        primitiveSuccess = after.interaction >= 0.7;
        notes = 'pointer interaction restored';
        break;
      case 'PLAYER_HEALTH_RECOVERY':
        primitiveSuccess = after.interaction >= 0.7 && after.scrollability >= 0.7;
        notes = 'player interaction and scrollability restored';
        break;
      case 'TEMPORARY_NETWORK_ALLOW':
        primitiveSuccess = context.requestSucceeded === true
          && (context.antiBlockReactionImproved === true || (after.networkIntegrity ?? 0) >= (before.networkIntegrity ?? 0) + 0.05);
        notes = 'first-party dependency health improved';
        break;
      case 'TEMPORARY_NETWORK_BLOCK':
      case 'TARGETED_SESSION_DNR':
        primitiveSuccess = context.requestSuppressed === true
          && (after.networkIntegrity === undefined
            || before.networkIntegrity === undefined
            || after.networkIntegrity >= before.networkIntegrity - 0.05);
        notes = 'network intervention preserved page health';
        break;
      case 'CLOSE_HIGH_CONFIDENCE_UNWANTED_TARGET':
        primitiveSuccess = context.targetClosed === true
          && context.targetExists !== true
          && after.navigationHealth >= 0.7;
        notes = 'unwanted target closed while source navigation stayed healthy';
        break;
      case 'STOP_MATCHED_REDIRECT_CHAIN':
        primitiveSuccess = context.redirectStopped === true && after.navigationHealth >= 0.7;
        notes = 'matched redirect chain stopped while source navigation stayed healthy';
        break;
      default:
        primitiveSuccess = false;
        notes = 'primitive has no verified outcome contract';
    }

    return {
      success: primitiveSuccess && safe,
      scoreDelta: scoreDelta(before, after),
      notes: primitiveSuccess && safe ? notes : `${notes}; safety floor failed or effect was not observed`,
    };
  }
}
