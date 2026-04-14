/**
 * mc-render.js
 *
 * Renders Monte Carlo results into the Risk Outcomes sub-tab.
 * Registers window.RetireMCRender.
 *
 * Depends on:
 *   window.RetireData  — for D.formatMoney
 *
 * Public API:
 *   RetireMCRender.setResults(result)  — store result from mc-engine.js
 *   RetireMCRender.render()            — paint stat cards + narrative report
 */

(function () {
  'use strict';

  const D = window.RetireData;

  // ── Formatters ────────────────────────────────────────────────────────────
  function fmt(n) {
    if (D && D.formatMoney) return D.formatMoney(n);
    return '£' + Math.round(n).toLocaleString('en-GB');
  }

  function fmtPct(ratio) {
    return (ratio * 100).toFixed(1) + '%';
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let _result = null;

  // ── Public: store result ──────────────────────────────────────────────────
  function setResults(result) {
    _result = result;
  }

  // ── Public: render everything ─────────────────────────────────────────────
  function render() {
    if (!_result) return;
    _renderNarrative();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NARRATIVE REPORT
  // Six labelled sections injected into #mc-narrative.
  // ─────────────────────────────────────────────────────────────────────────
  function _renderNarrative() {
    const el = document.getElementById('mc-narrative');
    if (!el) return;

    const r         = _result;
    const lastIdx   = r.years.length - 1;
    const lastYear  = r.years[lastIdx];

    // ── Helper: find first year a percentile array hits zero (depletion) ──
    function depletionYear(arr) {
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] <= 0) return r.years[i];
      }
      return null;
    }

    // ── Helper: find peak value and year in an array ──────────────────────
    function peak(arr) {
      let maxVal = -Infinity, maxIdx = 0;
      arr.forEach((v, i) => { if (v > maxVal) { maxVal = v; maxIdx = i; } });
      return { value: maxVal, year: r.years[maxIdx] };
    }

    // Update sim count in subtitle
    const simCountEl = document.getElementById('mc-sim-count');
    if (simCountEl) simCountEl.textContent = r.simCount.toLocaleString('en-GB');

    // ── 1. VERDICT ────────────────────────────────────────────────────────
    const successPaths = Math.round(r.successRate * r.simCount);
    const verdictClass =
      r.successRate >= 0.90 ? 'mc-verdict--strong' :
      r.successRate >= 0.75 ? 'mc-verdict--moderate' :
                              'mc-verdict--weak';
    const verdictLabel =
      r.successRate >= 0.90 ? 'This is a strong result.' :
      r.successRate >= 0.75 ? 'This is a moderate result — some vulnerability to poor sequences.' :
                              'This result warrants attention — a significant proportion of paths fail.';

    const verdictHTML = `
      <section class="mc-section mc-verdict ${verdictClass}">
        <h4 class="mc-section-heading">Verdict</h4>
        <p>Your plan succeeds in ${successPaths.toLocaleString('en-GB')} of
        ${r.simCount.toLocaleString('en-GB')} simulations
        (${fmtPct(r.successRate)}). ${verdictLabel}</p>
      </section>`;

    // ── 2. KEY FIGURES ────────────────────────────────────────────────────
    const keyFiguresHTML = `
      <div class="mc-key-figures">
        <div class="mc-key-figure">
          <span class="mc-key-figure__label">10th percentile</span>
          <span class="mc-key-figure__value">${fmt(r.p10Portfolio[lastIdx])}</span>
          <span class="mc-key-figure__sub">final portfolio</span>
        </div>
        <div class="mc-key-figure">
          <span class="mc-key-figure__label">Median</span>
          <span class="mc-key-figure__value">${fmt(r.p50Portfolio[lastIdx])}</span>
          <span class="mc-key-figure__sub">final portfolio</span>
        </div>
        <div class="mc-key-figure">
          <span class="mc-key-figure__label">90th percentile</span>
          <span class="mc-key-figure__value">${fmt(r.p90Portfolio[lastIdx])}</span>
          <span class="mc-key-figure__sub">final portfolio</span>
        </div>
      </div>`;

    // ── 3. MEDIAN OUTCOME ─────────────────────────────────────────────────
    const p50Peak     = peak(r.p50Portfolio);
    const p50Depletes = depletionYear(r.p50Portfolio);
    let medianBody;
    if (p50Depletes) {
      const yearsEarly = lastYear - p50Depletes;
      medianBody = `In the median scenario, the portfolio is exhausted by
        ${p50Depletes} — ${yearsEarly} year${yearsEarly !== 1 ? 's' : ''} before
        the end of the projection.`;
    } else {
      medianBody = `In the median scenario, your portfolio peaks at
        ${fmt(p50Peak.value)} around ${p50Peak.year} and finishes at
        ${fmt(r.p50Portfolio[lastIdx])} in ${lastYear}.`;
    }

    const medianHTML = `
      <section class="mc-section">
        <h4 class="mc-section-heading">Median outcome</h4>
        <p>${medianBody}</p>
      </section>`;

    // ── 3. STRESS CASE (p10) ──────────────────────────────────────────────
    const p10Depletes = depletionYear(r.p10Portfolio);
    let stressBody;
    if (p10Depletes) {
      const yearsEarly = lastYear - p10Depletes;
      stressBody = `In the stress case (bottom 10% of outcomes), the portfolio
        runs out by ${p10Depletes} — ${yearsEarly} year${yearsEarly !== 1 ? 's' : ''}
        before the end of the projection. This scenario typically reflects a
        combination of poor early returns and elevated inflation.`;
    } else {
      stressBody = `In a poor returns environment (bottom 10%), your portfolio
        retains ${fmt(r.p10Portfolio[lastIdx])} by ${lastYear}. While significantly
        below the median, the plan remains solvent throughout the projection under
        this stress scenario.`;
    }

    const stressHTML = `
      <section class="mc-section">
        <h4 class="mc-section-heading">Stress case (p10)</h4>
        <p>${stressBody}</p>
      </section>`;

    // ── 4. OPTIMISTIC CASE (p90) ──────────────────────────────────────────
    const p90Final    = r.p90Portfolio[lastIdx];
    const legacyNote  = p90Final > 500_000
      ? ' This would leave meaningful wealth to pass on or deploy in later life.'
      : '';
    const optimisticHTML = `
      <section class="mc-section">
        <h4 class="mc-section-heading">Optimistic case (p90)</h4>
        <p>In a favourable environment (top 10% of outcomes), your portfolio
        reaches ${fmt(p90Final)} by ${lastYear}.${legacyNote}</p>
      </section>`;

    // ── 5. TAX DRAG ───────────────────────────────────────────────────────
    const nonZeroTax  = r.medianTotalTax.filter(v => v > 0);
    const avgTax      = nonZeroTax.length
      ? nonZeroTax.reduce((s, v) => s + v, 0) / nonZeroTax.length
      : 0;
    const taxPeak     = peak(r.medianTotalTax);
    const taxPeakYear = taxPeak.value > 0 ? taxPeak.year : null;

    let taxBody;
    if (avgTax < 100) {
      taxBody = `Across the median path, your household pays negligible income
        tax — the withdrawal strategy keeps income within tax-free allowances
        for most of the projection.`;
    } else {
      const peakClause = taxPeakYear
        ? ` Tax drag peaks at ${fmt(taxPeak.value)}/year around ${taxPeakYear}, principally
            reflecting the period of heaviest pension withdrawals.`
        : '';
      taxBody = `Across the median path, your household pays an average of
        ${fmt(avgTax)}/year in income tax, principally on pension withdrawals.${peakClause}`;
    }

    const taxHTML = `
      <section class="mc-section">
        <h4 class="mc-section-heading">Tax drag</h4>
        <p>${taxBody}</p>
      </section>`;

    // ── 6. ASSUMPTIONS NOTE ───────────────────────────────────────────────
    // r.equityVol/inflationVol are decimals (e.g. 0.16). Fall back to the
    // Assumptions inputs if the worker result doesn't carry them.
    const eVolRaw = r.equityVol != null
      ? r.equityVol
      : (parseFloat(document.getElementById('equityVol')?.value) || 16) / 100;
    const iVolRaw = r.inflationVol != null
      ? r.inflationVol
      : (parseFloat(document.getElementById('inflationVol')?.value) || 1.5) / 100;
    const eVol = (eVolRaw * 100).toFixed(0);
    const iVol = (iVolRaw * 100).toFixed(1);
    const volLabel =
      eVolRaw >= 0.18 ? 'an aggressive set of assumptions reflecting very high uncertainty' :
      eVolRaw >= 0.14 ? 'a cautious set of assumptions reflecting elevated uncertainty in both markets and inflation' :
                        'a moderate set of assumptions broadly consistent with long-run historical ranges';

    const assumHTML = `
      <section class="mc-section mc-section--muted">
        <h4 class="mc-section-heading">Assumptions</h4>
        <p>This stress test uses ${eVol}% equity volatility and ${iVol}% inflation
        volatility — ${volLabel}. Each of the
        ${r.simCount.toLocaleString('en-GB')} paths independently samples annual
        returns and inflation, compounding uncertainty across the full
        ${r.years.length}-year projection.</p>
      </section>`;

    el.innerHTML = verdictHTML + keyFiguresHTML + medianHTML + stressHTML + optimisticHTML + taxHTML + assumHTML;
  }

  // ── Register global ───────────────────────────────────────────────────────
  window.RetireMCRender = { setResults, render };

})();
