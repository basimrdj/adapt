import { extractSiteKey } from '../../core/navigation/epoch';
import { STORAGE_KEYS } from '../../shared/constants';
import { hostIsPaused, sanitizePausedHosts } from '../../shared/paused-hosts';
import { SiteRecipe, AuditEvent } from '../../shared/types';

function toggleRow(row: HTMLElement, detail: HTMLElement): void {
  const open = row.getAttribute('aria-expanded') === 'true';
  row.setAttribute('aria-expanded', String(!open));
  detail.hidden = open;
}

document.addEventListener('DOMContentLoaded', () => {
  const btnOptions = document.getElementById('btn-options')!;
  const rowThreat = document.getElementById('row-threat')!;
  const rowPrivacy = document.getElementById('row-privacy')!;
  const rowPerformance = document.getElementById('row-performance')!;
  const detailThreat = document.getElementById('detail-threat')!;
  const detailPrivacy = document.getElementById('detail-privacy')!;
  const detailPerformance = document.getElementById('detail-performance')!;
  const dtSiteLine = document.getElementById('dt-site-line')!;
  const dtRecipeLine = document.getElementById('dt-recipe-line')!;
  const dtAudit = document.getElementById('dt-audit')!;
  const heroTitle = document.getElementById('hero-title')!;
  const heroSub = document.getElementById('hero-sub')!;
  const livePill = document.getElementById('live-pill')!;
  const liveText = document.getElementById('live-text')!;
  const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
  const stateThreat = document.getElementById('state-threat')!;

  btnOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
  rowThreat.addEventListener('click', () => toggleRow(rowThreat, detailThreat));
  rowPrivacy.addEventListener('click', () => toggleRow(rowPrivacy, detailPrivacy));
  rowPerformance.addEventListener('click', () => toggleRow(rowPerformance, detailPerformance));

  let siteKey: string | null = null;

  // The popup only writes the paused-host list; the background's storage
  // listener is the single writer of the DNR allowance and reloads the tab.
  function renderPauseState(paused: boolean): void {
    if (!siteKey) return;
    heroTitle.textContent = paused ? 'Protection Paused' : 'Protection Active';
    heroSub.textContent = paused
      ? `ADAPT is standing down on ${siteKey}.`
      : 'You\u2019re protected across the modern web.';
    livePill.classList.toggle('paused', paused);
    liveText.textContent = paused ? 'Paused' : 'Live';
    btnPause.textContent = paused ? 'Resume on this site' : 'Pause on this site';
    btnPause.title = paused ? `Resume protection on ${siteKey}` : `Pause protection on ${siteKey}`;
    stateThreat.textContent = paused ? 'Paused' : 'On';
  }

  btnPause.addEventListener('click', () => {
    if (!siteKey) return;
    const host = siteKey;
    chrome.storage.local.get([STORAGE_KEYS.PAUSED_HOSTS], (data) => {
      const list = sanitizePausedHosts(data[STORAGE_KEYS.PAUSED_HOSTS]);
      const paused = hostIsPaused(host, list);
      const next = paused ? list.filter((entry) => entry !== host) : [...list, host];
      chrome.storage.local.set({ [STORAGE_KEYS.PAUSED_HOSTS]: next }, () => {
        renderPauseState(!paused);
      });
    });
  });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    siteKey = tab?.url ? extractSiteKey(tab.url) : null;
    dtSiteLine.textContent = siteKey ? `Current site: ${siteKey}` : 'No web page in this tab.';

    if (!siteKey) {
      dtRecipeLine.textContent = '';
      btnPause.hidden = true;
    } else {
      btnPause.hidden = false;
      chrome.storage.local.get([STORAGE_KEYS.PAUSED_HOSTS], (data) => {
        renderPauseState(hostIsPaused(siteKey!, sanitizePausedHosts(data[STORAGE_KEYS.PAUSED_HOSTS])));
      });
      chrome.storage.local.get([STORAGE_KEYS.RECIPES], (data) => {
        const recipes = data[STORAGE_KEYS.RECIPES] as Record<string, SiteRecipe> | undefined;
        const recipe = recipes?.[siteKey!];
        dtRecipeLine.textContent = recipe
          ? `Adaptive recipe ${recipe.state} — ${recipe.actions.length} action(s) staged for this host.`
          : 'Baseline static protection — no site adaptation needed yet.';
      });
    }
  });

  chrome.storage.local.get([STORAGE_KEYS.AUDIT_LOGS], (data) => {
    const logs = (data[STORAGE_KEYS.AUDIT_LOGS] as AuditEvent[]) || [];
    dtAudit.innerHTML = '';
    if (logs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'audit-item audit-empty';
      empty.textContent = 'No adaptation events recorded yet.';
      dtAudit.appendChild(empty);
      return;
    }
    logs.slice(-10).reverse().forEach((log) => {
      const item = document.createElement('div');
      item.className = 'audit-item';
      const time = new Date(log.timestamp).toLocaleTimeString();
      item.textContent = `[${time}] ${log.eventType} · ${log.siteKey}`;
      dtAudit.appendChild(item);
    });
  });
});
