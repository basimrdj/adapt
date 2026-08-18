(() => {
  const modified = new URL(window.location.href).searchParams.get('detector') === 'modified';
  window.__phase3_detector_version = modified ? 'modified' : 'original';
  window.__phase3_detector_ticks = 0;

  const update = () => {
    window.__phase3_detector_ticks += 1;
    const bait = document.getElementById('phase3-bait');
    const hidden = !bait || bait.offsetWidth === 0 || bait.offsetHeight === 0;
    let gate = document.getElementById('phase3-acceptance-gate');

    if (hidden && !gate) {
      gate = document.createElement('div');
      gate.id = 'phase3-acceptance-gate';
      gate.className = 'phase3-gate';
      gate.textContent = modified
        ? 'Access is temporarily unavailable. Please wait.'
        : 'Adblock detected. Disable your blocker.';
      document.body.appendChild(gate);
      // The modified detector deliberately changes a structural/technical
      // feature while retaining the same origin/path and causal bait shape.
      // A stored recipe must invalidate before applying on this variant.
      document.body.style.overflow = modified ? 'auto' : 'hidden';
    } else if (!hidden && gate) {
      gate.remove();
      document.body.style.overflow = 'auto';
      window.__phase3_true_mechanism_observed = true;
    }
  };

  // Delay the first gate so the script-complete request event is guaranteed
  // to be in the extension's causal graph before the gate-bearing observation
  // batch arrives — both hypotheses then exist at the first experiment
  // selection and the discriminator order is deterministic.
  window.setTimeout(() => {
    update();
    window.setInterval(update, 50);
  }, 400);
})();
