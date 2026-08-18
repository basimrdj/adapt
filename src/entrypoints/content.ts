import { PageSensor } from '../page/sensor';
import { PageFilteringRuntime } from '../page/filtering/runtime';
import { initBaitReplay } from '../page/stealth/bait-replay';
import { initCosmeticReplayGuard } from '../page/stealth/cosmetic-guard';
import { STORAGE_KEYS } from '../shared/constants';
import { hostIsPaused, sanitizePausedHosts } from '../shared/paused-hosts';

function startRuntime(): void {
  // Initialize PageSensor at document_start
  const navigationId = `page_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const pageFiltering = new PageFilteringRuntime();
  const sensor = new PageSensor(navigationId);
  pageFiltering.init();
  sensor.init();
  initBaitReplay();
  initCosmeticReplayGuard();
}

// Per-site pause: when the user has allowlisted this host, the content-side
// planes (sensor, page filtering, stealth guards) stand down alongside the
// background engine and the DNR allowance. The storage read races page start,
// which is acceptable: pausing/unpausing reloads the tab, so the list read here
// is already the settled one. A read failure starts the runtime — fail closed
// to protection, never silently unprotected.
//
// When paused we also notify the MAIN-world popup broker, which is
// manifest-injected and cannot read storage. The signal is a transient
// postMessage (no DOM marker — nothing for a detector to fingerprint). The
// broker only acts on window.open calls, which always happen after page
// scripts run, so delivery at document_start + the first lifecycle ticks is
// deterministic in practice; the reposts cover world-ordering races.
const BROKER_STANDDOWN = { kind: 'adapt-popup-broker-standdown' };

function announcePaused(): void {
  try {
    window.postMessage(BROKER_STANDDOWN, '*');
  } catch {
    /* never throw into the page */
  }
}

try {
  chrome.storage.local.get([STORAGE_KEYS.PAUSED_HOSTS], (data) => {
    const paused = hostIsPaused(
      window.location.hostname.toLowerCase(),
      sanitizePausedHosts(data?.[STORAGE_KEYS.PAUSED_HOSTS])
    );
    if (!paused) {
      startRuntime();
      return;
    }
    announcePaused();
    document.addEventListener('readystatechange', announcePaused, { once: true });
    document.addEventListener('DOMContentLoaded', announcePaused, { once: true });
  });
} catch {
  startRuntime();
}
