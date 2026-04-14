/**
 * mc-render.js
 *
 * Renders Monte Carlo results into the Outcomes tab.
 * Registers window.RetireMCRender.
 *
 * Depends on:
 *   window.RetireData  — for D.formatMoney
 *   Chart.js           — already loaded globally
 *
 * Public API:
 *   RetireMCRender.setResults(result)  — store result from mc-engine.js
 *   RetireMCRender.render()            — paint stat cards + both charts
 *
 * Chart anatomy:
 *   Fan chart  (#mcFanChart) — line chart with five filled bands:
 *     outer band  p10–p90  (lightest fill)
 *     inner band  p25–p75  (medium fill)
 *     median line p50      (solid line, no fill)
 *   Achieved via Chart.js 'line' type with 'fill' referencing dataset indices.
 *
 *   Tax chart (#mcTaxChart) — bar chart of medianTotalTax per year.
 */

(function () {
  'use strict';

  const D = window.RetireData;

  // ── Formatter ─────────────────────────────────────────────────────────────
  // Graceful fallback if RetireData isn't loaded yet (shouldn't happen in
  // normal load order, but guards against test harnesses).
  function fmt(n) {
    if (D && D.formatMoney) return D.formatMoney(n);
    return '£' + Math.round(n).toLocaleString('en-GB');
  }

  function fmtPct(ratio) {
    return (ratio * 100).toFixed(1) + '%';
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let _result      = null;
  let _fanChart    = null;
  let _taxChart    = null;

  // ── Colour tokens — consistent with the app's blue/red palette ───────────
  const BLUE      = 'rgb(59,130,246)';
  const BLUE_25   = 'rgba(59,130,246,0.25)';
  const BLUE_15   = 'rgba(59,130,246,0.15)';
  const RED_70    = 'rgba(239,68,68,0.70)';
  const RED_90    = 'rgba(239,68,68,0.90)';

  // ── Public: store result ──────────────────────────────────────────────────
  function setResults(result) {
    _result = result;
  }

  // ── Public: render everything ─────────────────────────────────────────────
  function render() {
    if (!_result) return;
    _renderStatCards();
    _renderFanChart();
    _renderTaxChart();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STAT CARDS
  // ─────────────────────────────────────────────────────────────────────────
  function _renderStatCards() {
    const r    = _result;
    const last = r.years.length - 1;

    _setText('mc-sim-count',   r.simCount.toLocaleString('en-GB'));
    _setText('mc-success-rate', fmtPct(r.successRate));
    _setText('mc-median-final', fmt(r.p50Portfolio[last]));
    _setText('mc-p10-final',    fmt(r.p10Portfolio[last]));
    _setText('mc-p90-final',    fmt(r.p90Portfolio[last]));

    // Colour the success rate by severity
    const srEl = document.getElementById('mc-success-rate');
    if (srEl) {
      srEl.style.color =
        r.successRate >= 0.90 ? 'var(--color-success, #16a34a)' :
        r.successRate >= 0.75 ? 'var(--color-warn,    #d97706)' :
                                'var(--color-danger,  #dc2626)';
    }
  }

  function _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FAN CHART
  // Five datasets in draw order so 'fill' references work correctly:
  //   [0] p10  — lower bound of outer band; filled TO [4] p90
  //   [1] p25  — lower bound of inner band; filled TO [3] p75
  //   [2] p50  — median line (no fill)
  //   [3] p75  — upper bound of inner band; filled TO [1] p25
  //   [4] p90  — upper bound of outer band; filled TO [0] p10
  //
  // Chart.js 'fill' with a dataset index fills the area between that dataset
  // and the referenced one.  We stack fills from the outside in so the
  // lighter outer band sits behind the darker inner band.
  // ─────────────────────────────────────────────────────────────────────────
  function _renderFanChart() {
    const r      = _result;
    // Values in £k so the y-axis labels stay compact (matching existing charts)
    const toK    = arr => arr.map(v => Math.round(v / 1000));
    const labels = r.years.map(String);

    const datasets = [
      // [0] p10 — paired with [4] p90 for outer fill
      {
        label:           'p10',
        data:            toK(r.p10Portfolio),
        borderColor:     'transparent',
        backgroundColor: BLUE_15,
        fill:            '+4',      // fill up to dataset index+4 (p90)
        pointRadius:     0,
        tension:         0.3,
        order:           5,
      },
      // [1] p25 — paired with [3] p75 for inner fill
      {
        label:           'p25',
        data:            toK(r.p25Portfolio),
        borderColor:     'transparent',
        backgroundColor: BLUE_25,
        fill:            '+2',      // fill up to dataset index+2 (p75)
        pointRadius:     0,
        tension:         0.3,
        order:           4,
      },
      // [2] p50 — median line, no fill
      {
        label:           'Median (p50)',
        data:            toK(r.p50Portfolio),
        borderColor:     BLUE,
        backgroundColor: 'transparent',
        fill:            false,
        pointRadius:     0,
        borderWidth:     2,
        tension:         0.3,
        order:           1,
      },
      // [3] p75 — upper inner boundary (no visible border, fill handled by p25)
      {
        label:           'p75',
        data:            toK(r.p75Portfolio),
        borderColor:     'transparent',
        backgroundColor: BLUE_25,
        fill:            false,
        pointRadius:     0,
        tension:         0.3,
        order:           3,
      },
      // [4] p90 — upper outer boundary (no visible border, fill handled by p10)
      {
        label:           'p90',
        data:            toK(r.p90Portfolio),
        borderColor:     'transparent',
        backgroundColor: BLUE_15,
        fill:            false,
        pointRadius:     0,
        tension:         0.3,
        order:           2,
      },
    ];

    const ctx = document.getElementById('mcFanChart')?.getContext('2d');
    if (!ctx) return;
    if (_fanChart) _fanChart.destroy();

    _fanChart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        interaction: {
          mode:      'index',
          intersect: false,
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: item => ['p10', 'Median (p50)', 'p90'].includes(item.dataset.label),
            callbacks: {
              label: ctx => {
                const val = (ctx.parsed.y || 0) * 1000;
                return `${ctx.dataset.label}: ${fmt(val)}`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { font: { size: 10 }, maxRotation: 45 },
          },
          y: {
            title: {
              display: true,
              text:    '£k (nominal)',
              font:    { size: 11 },
            },
            ticks: {
              font:     { size: 11 },
              callback: v => v + 'k',
            },
            min: 0,
          },
        },
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MEDIAN TAX BAR CHART
  // ─────────────────────────────────────────────────────────────────────────
  function _renderTaxChart() {
    const r      = _result;
    const toK    = arr => arr.map(v => Math.round(v / 1000));
    const labels = r.years.map(String);

    const ctx = document.getElementById('mcTaxChart')?.getContext('2d');
    if (!ctx) return;
    if (_taxChart) _taxChart.destroy();

    _taxChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label:           'Median tax paid',
          data:            toK(r.medianTotalTax),
          backgroundColor: RED_70,
          hoverBackgroundColor: RED_90,
          borderRadius:    2,
        }],
      },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const val = (ctx.parsed.y || 0) * 1000;
                return `Median tax: ${fmt(val)}`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { font: { size: 10 }, maxRotation: 45 },
          },
          y: {
            title: {
              display: true,
              text:    '£k (nominal)',
              font:    { size: 11 },
            },
            ticks: {
              font:     { size: 11 },
              callback: v => v + 'k',
            },
            min: 0,
          },
        },
      },
    });
  }

  // ── Register global ───────────────────────────────────────────────────────
  window.RetireMCRender = { setResults, render };

})();
