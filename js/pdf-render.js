/**
 * pdf-render.js
 *
 * Generates a multi-page A4 PDF retirement plan report from a plan snapshot.
 * Registers window.RetirePDFRender.
 *
 * Depends on (loaded via CDN before this file):
 *   window.jspdf.jsPDF   — jsPDF 2.x
 *   window.html2canvas   — html2canvas 1.x
 *
 * Public API:
 *   RetirePDFRender.generate(snapshot, chartCanvases)
 *
 *   snapshot      — assembled by export.js (_buildSnapshot)
 *   chartCanvases — { wealth: HTMLCanvasElement|null, income: HTMLCanvasElement|null }
 *
 * Architecture:
 *   1. Build each page as a styled HTML div (A4 at 794×1123px).
 *   2. Inject all pages into a hidden off-screen container.
 *   3. html2canvas renders each page at 2× scale.
 *   4. jsPDF receives each canvas as a full-page JPEG image.
 *   5. Blob is downloaded immediately.
 *
 * Design tokens mirror the IncomeFlow UI:
 *   Primary blue:  #315CE8
 *   Accent green:  #3B6D11 (on-track verdict)
 *   Amber:         #BA7517 (borderline)
 *   Red:           #A32D2D (at-risk)
 *   Text dark:     #1e293b
 *   Text mid:      #475569
 *   Text light:    #94a3b8
 *   Border:        #e2e8f0
 *   Background:    #f8fafc
 */

(function () {
  'use strict';

  // ── Design tokens ─────────────────────────────────────────────────────────
  const T = {
    blue:       '#315CE8',
    blueDark:   '#1e3a8a',
    blueLight:  '#e8eefb',
    green:      '#3B6D11',
    greenLight: '#EAF3DE',
    amber:      '#BA7517',
    amberLight: '#FAEEDA',
    red:        '#A32D2D',
    redLight:   '#FCEBEB',
    textDark:   '#1e293b',
    textMid:    '#475569',
    textLight:  '#94a3b8',
    border:     '#e2e8f0',
    bg:         '#f8fafc',
    white:      '#ffffff',
  };

  // A4 at 96dpi
  const PAGE_W = 794;
  const PAGE_H = 1123;
  const MARGIN = 48;
  const INNER_W = PAGE_W - MARGIN * 2;

  // ── Formatters ────────────────────────────────────────────────────────────
  function fmt(n) {
    if (n == null) return '—';
    return '£' + Math.round(n).toLocaleString('en-GB');
  }
  function fmtPct(r) {
    if (r == null) return '—';
    if (r >= 0.995) return '99%+';
    return Math.round(r * 100) + '%';
  }
  function fmtPctRaw(r) {
    if (r == null) return '—';
    return (r * 100).toFixed(1) + '%';
  }
  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // ── Verdict colour helper ─────────────────────────────────────────────────
  function verdictColours(rate) {
    if (rate == null) return { bg: T.blue, light: T.blueLight, text: T.blueDark };
    if (rate >= 0.95) return { bg: T.green,  light: T.greenLight, text: T.green };
    if (rate >= 0.90) return { bg: T.blue,   light: T.blueLight,  text: T.blue  };
    if (rate >= 0.80) return { bg: T.amber,  light: T.amberLight, text: T.amber };
    return               { bg: T.red,    light: T.redLight,   text: T.red   };
  }

  function impactColour(level) {
    if (level === 'low')      return T.green;
    if (level === 'moderate') return T.amber;
    if (level === 'high')     return T.red;
    return T.textLight;
  }

  // ── Base page shell ───────────────────────────────────────────────────────
  function pageShell(pageNum, totalPages, content, opts = {}) {
    const headerBg = opts.headerBg || T.blue;
    const headerContent = opts.headerContent || '';
    return `
      <div style="
        width:${PAGE_W}px;height:${PAGE_H}px;
        background:${T.white};
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        font-size:13px;color:${T.textDark};
        display:flex;flex-direction:column;
        box-sizing:border-box;
        position:relative;
        overflow:hidden;
      ">
        ${headerContent}
        <div style="flex:1;padding:${MARGIN}px;overflow:hidden;box-sizing:border-box;">
          ${content}
        </div>
        <div style="
          padding:12px ${MARGIN}px;
          border-top:1px solid ${T.border};
          display:flex;justify-content:space-between;align-items:center;
          font-size:10px;color:${T.textLight};
          flex-shrink:0;
        ">
          <span>IncomeFlow Retirement Plan Report</span>
          <span>Page ${pageNum} of ${totalPages}</span>
        </div>
      </div>`;
  }

  function sectionLabel(text) {
    return `<div style="
      font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;
      color:${T.textLight};margin-bottom:10px;
    ">${text}</div>`;
  }

  function divider() {
    return `<div style="height:1px;background:${T.border};margin:18px 0;"></div>`;
  }

  function pill(text, bg, color) {
    return `<span style="
      display:inline-block;padding:2px 10px;border-radius:999px;
      font-size:10px;font-weight:700;background:${bg};color:${color};
    ">${text}</span>`;
  }

  function statCard(label, value, sub) {
    return `
      <div style="
        background:${T.bg};border:1px solid ${T.border};border-radius:10px;
        padding:14px 16px;flex:1;min-width:0;
      ">
        <div style="font-size:10px;color:${T.textLight};font-weight:600;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px;">${label}</div>
        <div style="font-size:18px;font-weight:700;color:${T.textDark};line-height:1.1;">${value}</div>
        ${sub ? `<div style="font-size:11px;color:${T.textMid};margin-top:4px;">${sub}</div>` : ''}
      </div>`;
  }

  // ── PAGE 1: Cover / Verdict ───────────────────────────────────────────────
  function buildPage1(s) {
    const r      = s.results;
    const rate   = r.success_rate;
    const vc     = verdictColours(rate);
    const n      = s.narrative;
    const plan   = s.plan;
    const names  = s.meta.persons.map(p => p.name).join(' & ');
    const mcRun  = s.meta.mc_run;

    const heroContent = `
      <div style="background:${vc.bg};padding:32px ${MARGIN}px 28px;flex-shrink:0;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:rgba(255,255,255,0.7);margin-bottom:8px;">Retirement Plan Report</div>
            <div style="font-size:36px;font-weight:800;color:#fff;line-height:1;letter-spacing:-0.02em;">
              ${mcRun ? (n.verdict_state || 'Plan assessed') : 'Projection complete'}
            </div>
            <div style="font-size:13px;color:rgba(255,255,255,0.85);margin-top:10px;max-width:400px;line-height:1.5;">
              ${n.verdict_sentence || r.verdict_summary || ''}
            </div>
          </div>
          <div style="text-align:right;flex-shrink:0;margin-left:24px;">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.65);margin-bottom:4px;">Likelihood of holding up</div>
            <div style="font-size:56px;font-weight:800;color:#fff;line-height:1;letter-spacing:-0.03em;">${mcRun ? fmtPct(rate) : '—'}</div>
            <div style="font-size:10px;color:rgba(255,255,255,0.6);margin-top:4px;">${mcRun ? `${(r.sim_count||10000).toLocaleString('en-GB')} simulations` : 'MC not run'}</div>
          </div>
        </div>
      </div>`;

    const startingPortfolio = (
      (plan.p1.starting_balances.Cash    || 0) +
      (plan.p1.starting_balances.GIAeq   || 0) +
      (plan.p1.starting_balances.GIAcash || 0) +
      (plan.p1.starting_balances.SIPP    || 0) +
      (plan.p1.starting_balances.ISA     || 0) +
      (plan.p2 ? (plan.p2.starting_balances.Cash    || 0) : 0) +
      (plan.p2 ? (plan.p2.starting_balances.GIAeq   || 0) : 0) +
      (plan.p2 ? (plan.p2.starting_balances.GIAcash || 0) : 0) +
      (plan.p2 ? (plan.p2.starting_balances.SIPP    || 0) : 0) +
      (plan.p2 ? (plan.p2.starting_balances.ISA     || 0) : 0)
    );

    const cards = `
      <div style="display:flex;gap:12px;margin-bottom:20px;">
        ${statCard('Starting portfolio',   fmt(startingPortfolio), `${plan.start_year}`)}
        ${statCard('Target net income',    fmt(plan.spending_target_net), 'per year')}
        ${statCard('Median outcome',       mcRun ? fmt(r.terminal_portfolio.p50) : '—', 'terminal portfolio')}
        ${statCard('Weaker outcome (p10)', mcRun ? fmt(r.terminal_portfolio.p10) : '—', 'terminal portfolio')}
      </div>`;

    const sustainLine = r.sustainable_spending
      ? r.sustainable_spending.is_floor
        ? `Sustainable spending is well above your target — the plan has substantial headroom.`
        : r.sustainable_spending.amount >= plan.spending_target_net
          ? `Estimated sustainable spending: ${fmt(r.sustainable_spending.amount)} / year — ${fmt(r.sustainable_spending.amount - plan.spending_target_net)} annual headroom above target.`
          : `Estimated sustainable spending: ${fmt(r.sustainable_spending.amount)} / year — ${fmt(plan.spending_target_net - r.sustainable_spending.amount)} below target.`
      : '';

    const metaLine = `
      <div style="display:flex;gap:24px;margin-top:16px;font-size:11px;color:${T.textMid};">
        <span><b>Plan:</b> ${plan.start_year} – ${plan.end_year}</span>
        <span><b>People:</b> ${names}</span>
        <span><b>Strategy:</b> ${plan.strategy_label || plan.strategy}</span>
        <span><b>Generated:</b> ${fmtDate(s.generated_at)}</span>
      </div>`;

    const body = cards
      + (sustainLine ? `<p style="font-size:12px;color:${T.textMid};margin:0 0 16px;line-height:1.6;">${sustainLine}</p>` : '')
      + divider()
      + `<p style="font-size:11px;color:${T.textLight};line-height:1.6;margin:0;">
          This report is generated from a deterministic projection and Monte Carlo simulation. It is not financial advice.
          All figures are illustrative and depend on the assumptions stated in this report. Past market behaviour does not
          guarantee future results. Review your plan regularly and consult a qualified financial adviser for personalised guidance.
        </p>`
      + metaLine;

    return pageShell(1, 8, body, { headerContent: heroContent });
  }

  // ── PAGE 2: Your Plan (inputs + assumptions headline) ────────────────────
  function buildPage2(s) {
    const plan = s.plan;
    const asmp = s.assumptions;

    function personBlock(p, label) {
      if (!p) return '';
      const sp = p.sp_annual_gross > 0
        ? `State Pension ${fmt(p.sp_annual_gross)}/yr from age ${p.sp_age}`
        : 'No State Pension configured';
      const sal = p.salary > 0
        ? `${fmt(p.salary)}/yr salary until age ${p.salary_stop_age}`
        : 'No employment income';
      return `
        <div style="flex:1;min-width:0;">
          <div style="font-size:11px;font-weight:700;color:${T.textMid};text-transform:uppercase;letter-spacing:0.07em;margin-bottom:8px;">${label}</div>
          <div style="font-size:13px;font-weight:700;color:${T.textDark};margin-bottom:4px;">${p.name}</div>
          <div style="font-size:12px;color:${T.textMid};line-height:1.8;">
            Born ${p.dob_year}<br>
            ${sp}<br>
            ${sal}
          </div>
        </div>`;
    }

    function wrapperRow(label, p1val, p2val) {
      return `
        <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid ${T.border};font-size:12px;">
          <span style="color:${T.textMid};">${label}</span>
          <span style="font-weight:600;color:${T.textDark};">${fmt(p1val)}${p2val != null ? ` / ${fmt(p2val)}` : ''}</span>
        </div>`;
    }

    const p1 = plan.p1;
    const p2 = plan.p2;

    const peopleBlock = `
      <div style="display:flex;gap:24px;margin-bottom:20px;">
        ${personBlock(p1, 'Person 1')}
        ${p2 ? `<div style="width:1px;background:${T.border};flex-shrink:0;"></div>` : ''}
        ${personBlock(p2, 'Person 2')}
      </div>`;

    const wrappers = `
      <div style="margin-bottom:20px;">
        ${sectionLabel('Starting portfolio balances')}
        ${wrapperRow('Cash',    p1.starting_balances.Cash,    p2?.starting_balances.Cash)}
        ${wrapperRow('GIA (equities)', p1.starting_balances.GIAeq, p2?.starting_balances.GIAeq)}
        ${wrapperRow('GIA (cashlike)', p1.starting_balances.GIAcash, p2?.starting_balances.GIAcash)}
        ${wrapperRow('SIPP',    p1.starting_balances.SIPP,    p2?.starting_balances.SIPP)}
        ${wrapperRow('ISA',     p1.starting_balances.ISA,     p2?.starting_balances.ISA)}
      </div>`;

    const planParams = `
      <div style="margin-bottom:20px;">
        ${sectionLabel('Plan parameters')}
        <div style="display:flex;gap:32px;flex-wrap:wrap;">
          <div style="font-size:12px;line-height:2;color:${T.textMid};">
            <div><b style="color:${T.textDark};">Target income:</b> ${fmt(plan.spending_target_net)} / yr net</div>
            <div><b style="color:${T.textDark};">Spending step-down:</b> ${plan.step_down_pct}% at age 75</div>
            <div><b style="color:${T.textDark};">Withdrawal strategy:</b> ${plan.strategy_label || plan.strategy}</div>
            <div><b style="color:${T.textDark};">Bed-and-ISA:</b> ${plan.bed_and_isa.enabled ? `${fmt(plan.bed_and_isa.p1_gia_annual)}/yr for ${plan.bed_and_isa.p1_years} yrs` : 'Disabled'}</div>
          </div>
          <div style="font-size:12px;line-height:2;color:${T.textMid};">
            <div><b style="color:${T.textDark};">Planning growth rate:</b> ${((plan.growth_rate_deterministic || 0) * 100).toFixed(2)}% nominal</div>
            <div><b style="color:${T.textDark};">Inflation:</b> ${((plan.inflation_rate || 0) * 100).toFixed(1)}%</div>
            <div><b style="color:${T.textDark};">Tax thresholds:</b> ${plan.threshold_mode === 'frozen' ? 'Frozen' : `Uprated from ${plan.threshold_from_year}`}</div>
            <div><b style="color:${T.textDark};">Dividend yield:</b> ${((plan.dividend_yield || 0) * 100).toFixed(1)}%</div>
          </div>
        </div>
      </div>`;

    const assumpHeadline = `
      <div style="background:${T.bg};border:1px solid ${T.border};border-radius:10px;padding:14px 16px;">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${T.textLight};margin-bottom:6px;">What this plan assumes</div>
        <p style="font-size:12px;color:${T.textMid};margin:0;line-height:1.6;">${asmp.headline}</p>
      </div>`;

    const body = sectionLabel('Your plan')
      + peopleBlock
      + divider()
      + wrappers
      + planParams
      + divider()
      + assumpHeadline;

    return pageShell(2, 8, body);
  }

  // ── PAGE 3: Outcomes (chart placeholder + terminal percentiles) ───────────
  function buildPage3(s) {
    const r = s.results;
    const mcRun = s.meta.mc_run;

    const termBlock = mcRun ? `
      <div style="display:flex;gap:10px;margin-bottom:20px;">
        ${statCard('Optimistic (p90)', fmt(r.terminal_portfolio.p90), 'terminal portfolio')}
        ${statCard('Typical (p50)',    fmt(r.terminal_portfolio.p50), 'terminal portfolio')}
        ${statCard('Weaker (p25)',     fmt(r.terminal_portfolio.p25), 'terminal portfolio')}
        ${statCard('Poor (p10)',       fmt(r.terminal_portfolio.p10), 'terminal portfolio')}
      </div>` : `<p style="color:${T.textLight};font-size:12px;">Monte Carlo not run — percentile data unavailable.</p>`;

    const sustainBlock = r.sustainable_spending ? `
      <div style="background:${T.bg};border:1px solid ${T.border};border-radius:10px;padding:14px 16px;margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:${T.textLight};margin-bottom:4px;">Estimated sustainable spending</div>
            <div style="font-size:22px;font-weight:800;color:${T.textDark};">${fmt(r.sustainable_spending.amount)} <span style="font-size:13px;font-weight:400;color:${T.textMid};">per year</span></div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:${T.textLight};margin-bottom:4px;">Sensitivity</div>
            <div style="font-size:16px;font-weight:700;color:${impactColour(r.sensitivity === 'low' ? 'low' : r.sensitivity === 'high' ? 'high' : 'moderate')};">${r.sensitivity ? r.sensitivity.charAt(0).toUpperCase() + r.sensitivity.slice(1) : '—'}</div>
          </div>
        </div>
      </div>` : '';

    // Chart placeholder — replaced by actual canvas image in generatePDF()
    const chartPlaceholder = `
      <div id="pdf-chart-placeholder-wealth" style="
        width:${INNER_W}px;height:260px;
        background:${T.bg};border:1px solid ${T.border};border-radius:10px;
        display:flex;align-items:center;justify-content:center;
        margin-bottom:20px;
        overflow:hidden;
      ">
        <span style="font-size:11px;color:${T.textLight};">Portfolio projection chart</span>
      </div>`;

    const body = sectionLabel('Projected outcomes')
      + chartPlaceholder
      + termBlock
      + sustainBlock
      + `<p style="font-size:11px;color:${T.textLight};line-height:1.6;margin:0;">
          Under tested scenarios · ${s.plan.start_year}–${s.plan.end_year} ·
          ${(r.sim_count || 10000).toLocaleString('en-GB')} Monte Carlo simulations.
          Results are illustrative and not guaranteed.
        </p>`;

    return pageShell(3, 8, body);
  }

  // ── PAGE 4: Decade survival + pressure ───────────────────────────────────
  function buildPage4(s) {
    const r  = s.results;
    const n  = s.narrative;
    const mcRun = s.meta.mc_run;

    const decadeBars = (r.survival_by_decade || []).map(d => {
      const pct = (d.survival_rate * 100).toFixed(1);
      const barColour = d.survival_rate >= 0.95 ? T.green : d.survival_rate >= 0.80 ? T.amber : T.red;
      const label = d.age_p1_end != null ? `Age ${d.age_p1_end}` : String(d.year);
      return `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
          <div style="width:60px;font-size:11px;color:${T.textMid};text-align:right;flex-shrink:0;">${label}</div>
          <div style="flex:1;height:16px;background:${T.border};border-radius:4px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${barColour};border-radius:4px;"></div>
          </div>
          <div style="width:40px;font-size:11px;font-weight:700;color:${barColour};">${pct}%</div>
        </div>`;
    }).join('');

    const survivalBlock = mcRun ? `
      <div style="margin-bottom:24px;">
        ${sectionLabel('Likelihood of portfolio surviving to each decade')}
        ${decadeBars || '<p style="font-size:12px;color:' + T.textLight + ';">No decade data available.</p>'}
        ${n.survival_note ? `<p style="font-size:12px;color:${T.textMid};margin:12px 0 0;line-height:1.6;">${n.survival_note}</p>` : ''}
      </div>` : '';

    const pressureBlock = n.pressure_sentence ? `
      <div style="margin-bottom:24px;">
        ${sectionLabel('Where pressure shows up')}
        <p style="font-size:13px;color:${T.textDark};line-height:1.7;margin:0;">${n.pressure_sentence}</p>
      </div>` : '';

    const incomeChartPlaceholder = `
      <div id="pdf-chart-placeholder-income" style="
        width:${INNER_W}px;height:240px;
        background:${T.bg};border:1px solid ${T.border};border-radius:10px;
        display:flex;align-items:center;justify-content:center;
        margin-bottom:8px;overflow:hidden;
      ">
        <span style="font-size:11px;color:${T.textLight};">Income sources chart</span>
      </div>
      <p style="font-size:10px;color:${T.textLight};margin:0 0 16px;">How your retirement income is funded year by year</p>`;

    const body = survivalBlock
      + pressureBlock
      + divider()
      + incomeChartPlaceholder;

    return pageShell(4, 8, body);
  }

  // ── PAGE 5: Stress testing ────────────────────────────────────────────────
  function buildPage5(s) {
    const st = s.stress_tests;
    const baseRate = s.results.success_rate;

    function stressBlock(id, label) {
      if (!st || !st[id]) return '';
      const sc = st[id];
      if (!sc.run) {
        return `
          <div style="border:1px solid ${T.border};border-radius:10px;padding:16px;margin-bottom:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <div style="font-size:13px;font-weight:700;color:${T.textDark};">${label}</div>
              <span style="font-size:10px;color:${T.textLight};font-style:italic;">Not tested</span>
            </div>
            <p style="font-size:12px;color:${T.textLight};margin:0;">${sc.description}</p>
          </div>`;
      }
      const col = impactColour(sc.impact_level);
      const deltaStr = sc.success_rate_delta != null
        ? (sc.success_rate_delta >= 0 ? '+' : '') + Math.round(sc.success_rate_delta * 100) + 'pp'
        : '';
      return `
        <div style="border:1px solid ${T.border};border-radius:10px;padding:16px;margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
            <div>
              <div style="font-size:13px;font-weight:700;color:${T.textDark};margin-bottom:2px;">${label}</div>
              <div style="font-size:11px;color:${T.textMid};">${sc.description}</div>
            </div>
            <div style="text-align:right;flex-shrink:0;margin-left:16px;">
              <div style="font-size:20px;font-weight:800;color:${col};">${fmtPct(sc.success_rate)}</div>
              <div style="font-size:10px;color:${T.textLight};">${deltaStr} vs baseline</div>
            </div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;">
            ${pill(sc.impact_level ? sc.impact_level.charAt(0).toUpperCase() + sc.impact_level.slice(1) + ' impact' : '—', col + '1a', col)}
            <span style="font-size:11px;color:${T.textMid};">Typical outcome: ${fmt(sc.terminal_portfolio_p50)}</span>
          </div>
          <p style="font-size:12px;color:${T.textMid};margin:0;line-height:1.6;">${sc.interpretation || ''}</p>
        </div>`;
    }

    const body = sectionLabel('Stress testing')
      + `<p style="font-size:12px;color:${T.textMid};margin:0 0 16px;line-height:1.6;">
          Each scenario tests how your plan holds up under a specific adverse condition.
          Baseline likelihood of holding up: <b style="color:${T.textDark};">${fmtPct(baseRate)}</b>.
        </p>`
      + stressBlock('sorr',       'Sequence risk — early market downturn')
      + stressBlock('inflation',  'High inflation')
      + stressBlock('lostDecade', 'Lost decade — sustained low growth');

    return pageShell(5, 8, body);
  }

  // ── PAGE 6: Levers ────────────────────────────────────────────────────────
  function buildPage6(s) {
    const n = s.narrative;

    function leverBlock(title, pill_text, pill_col, outcome) {
      return `
        <div style="border:1px solid ${T.border};border-radius:10px;padding:16px;margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <div style="font-size:13px;font-weight:700;color:${T.textDark};">${title}</div>
            ${pill_text ? pill(pill_text, pill_col + '18', pill_col) : ''}
          </div>
          <p style="font-size:12px;color:${T.textMid};margin:0;line-height:1.6;">${outcome || '—'}</p>
        </div>`;
    }

    const delayBlock = s.results.delay_perturbations && s.results.delay_perturbations.length ? `
      <div style="margin-top:16px;">
        ${sectionLabel('Impact of delaying withdrawals')}
        <div style="display:flex;gap:10px;">
          ${s.results.delay_perturbations.map(d => statCard(
            `Delay ${d.yearsDelay} yr${d.yearsDelay > 1 ? 's' : ''}`,
            fmtPct(d.successRate),
            'likelihood of holding up'
          )).join('')}
        </div>
      </div>` : '';

    const body = sectionLabel('What drives the outcome')
      + leverBlock('Spending level',     n.lever_spending_pill, T.green, n.lever_spending_outcome)
      + leverBlock('Delay withdrawals',  n.lever_delay_pill,    T.blue,  n.lever_delay_outcome)
      + leverBlock('Spending flexibility', n.lever_flex_pill,   T.amber, n.lever_flex_outcome)
      + delayBlock;

    return pageShell(6, 8, body);
  }

  // ── PAGE 7: Actions ───────────────────────────────────────────────────────
  function buildPage7(s) {
    const n  = s.narrative;
    const r  = s.results;
    const vc = verdictColours(r.success_rate);

    const actionHero = `
      <div style="background:${vc.light};border:1px solid ${vc.bg}33;border-radius:12px;padding:20px 24px;margin-bottom:20px;">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${vc.bg};margin-bottom:8px;">Best next move</div>
        <div style="font-size:16px;font-weight:700;color:${T.textDark};margin-bottom:8px;">${n.action_line || '—'}</div>
        <p style="font-size:13px;color:${T.textMid};margin:0;line-height:1.6;">${n.action_impact || ''}</p>
      </div>`;

    const bullets = (n.bullet_items || []).map(b => `
      <div style="display:flex;gap:12px;margin-bottom:10px;align-items:flex-start;">
        <div style="width:6px;height:6px;border-radius:50%;background:${vc.bg};flex-shrink:0;margin-top:5px;"></div>
        <p style="font-size:12px;color:${T.textMid};margin:0;line-height:1.6;">${b}</p>
      </div>`).join('');

    const practicalActions = `
      <div style="margin-top:20px;">
        ${sectionLabel('Good practice')}
        ${[
          'Review this plan annually, or after any significant market movement.',
          'Maintain 6–12 months of target spending in accessible cash to reduce sequence risk.',
          'A willingness to trim spending by 10–15% in poor return years materially improves resilience.',
          'Both State Pensions provide an inflation-linked income from age 67 — factor this into your planning horizon.',
        ].map(a => `
          <div style="display:flex;gap:12px;margin-bottom:10px;align-items:flex-start;">
            <div style="width:6px;height:6px;border-radius:50%;background:${T.blue};flex-shrink:0;margin-top:5px;"></div>
            <p style="font-size:12px;color:${T.textMid};margin:0;line-height:1.6;">${a}</p>
          </div>`).join('')}
      </div>`;

    const body = sectionLabel('Actions')
      + actionHero
      + (bullets ? `<div style="margin-bottom:16px;">${sectionLabel('Key points')}</div>${bullets}` : '')
      + divider()
      + practicalActions;

    return pageShell(7, 8, body);
  }

  // ── PAGE 8: Assumptions detail + disclaimer ───────────────────────────────
  function buildPage8(s) {
    const asmp = s.assumptions;

    const keyRows = (asmp.key || []).map(k => `
      <div style="padding:10px 0;border-bottom:1px solid ${T.border};">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px;">
          <div style="font-size:12px;font-weight:700;color:${T.textDark};">${k.label}</div>
          <div style="font-size:11px;font-weight:600;color:${T.blue};text-align:right;max-width:260px;">${k.value_display}</div>
        </div>
        <div style="font-size:11px;color:${T.textMid};line-height:1.5;">${k.why_it_matters}</div>
      </div>`).join('');

    const detail = asmp.detail;
    const detailBlock = detail ? `
      <div style="margin-top:16px;display:flex;gap:24px;flex-wrap:wrap;font-size:11px;color:${T.textMid};line-height:1.8;">
        <div>
          <b style="color:${T.textDark};">Blended net return:</b> ${detail.blended_net_return != null ? (detail.blended_net_return * 100).toFixed(2) + '%' : '—'}<br>
          <b style="color:${T.textDark};">Blended volatility:</b> ${detail.blended_vol != null ? (detail.blended_vol * 100).toFixed(2) + '%' : '—'}<br>
          <b style="color:${T.textDark};">Simulations:</b> ${(detail.sim_count || 10000).toLocaleString('en-GB')}
        </div>
        <div>
          <b style="color:${T.textDark};">Equity:</b> ${detail.portfolio_allocation?.equity_pct ?? '—'}% &nbsp;
          <b style="color:${T.textDark};">Bonds:</b> ${detail.portfolio_allocation?.bond_pct ?? '—'}% &nbsp;
          <b style="color:${T.textDark};">Cashlike:</b> ${detail.portfolio_allocation?.cashlike_pct ?? '—'}%<br>
          <b style="color:${T.textDark};">Annual fee:</b> ${detail.annual_fee != null ? (detail.annual_fee * 100).toFixed(2) + '%' : '—'}
        </div>
      </div>` : '';

    const disclaimer = `
      <div style="margin-top:20px;background:${T.bg};border:1px solid ${T.border};border-radius:10px;padding:14px 16px;">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${T.textLight};margin-bottom:8px;">Important notice</div>
        <p style="font-size:11px;color:${T.textMid};margin:0;line-height:1.7;">
          This report is produced by IncomeFlow, a personal retirement planning tool. It is for illustrative purposes only
          and does not constitute financial advice. Projections are based on assumptions that may not reflect future market
          conditions, tax rules, or personal circumstances. The Monte Carlo simulation tests a range of scenarios but cannot
          predict the future. UK tax rules are based on 2025/26 legislation and may change. You should review your plan
          regularly and consult a qualified independent financial adviser before making retirement decisions.
          IncomeFlow is not regulated by the FCA.
        </p>
      </div>`;

    const body = sectionLabel('Assumptions')
      + keyRows
      + detailBlock
      + disclaimer;

    return pageShell(8, 8, body);
  }

  // ── Inject chart canvas into placeholder ──────────────────────────────────
  function injectChart(container, placeholderId, sourceCanvas) {
    if (!sourceCanvas) return;
    const placeholder = container.querySelector('#' + placeholderId);
    if (!placeholder) return;
    const img = document.createElement('img');
    img.src    = sourceCanvas.toDataURL('image/png');
    img.style.cssText = `width:100%;height:100%;object-fit:contain;display:block;`;
    placeholder.innerHTML = '';
    placeholder.appendChild(img);
  }

  // ── Main generate function ────────────────────────────────────────────────
  async function generate(snapshot, chartCanvases) {
    const { jsPDF } = window.jspdf;
    if (!jsPDF)        throw new Error('jsPDF not loaded');
    if (!window.html2canvas) throw new Error('html2canvas not loaded');

    chartCanvases = chartCanvases || {};

    // ── Build page HTML ────────────────────────────────────────────────────
    const pages = [
      buildPage1(snapshot),
      buildPage2(snapshot),
      buildPage3(snapshot),
      buildPage4(snapshot),
      buildPage5(snapshot),
      buildPage6(snapshot),
      buildPage7(snapshot),
      buildPage8(snapshot),
    ];

    // ── Off-screen container ───────────────────────────────────────────────
    const container = document.createElement('div');
    container.style.cssText = `
      position:fixed;left:-9999px;top:0;
      width:${PAGE_W}px;
      visibility:hidden;pointer-events:none;z-index:-1;
    `;
    container.innerHTML = pages.join('');
    document.body.appendChild(container);

    // Inject chart canvases into page placeholders
    injectChart(container, 'pdf-chart-placeholder-wealth', chartCanvases.wealth);
    injectChart(container, 'pdf-chart-placeholder-income', chartCanvases.income);

    // ── Render each page ───────────────────────────────────────────────────
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
    const pdfW = pdf.internal.pageSize.getWidth();
    const pdfH = pdf.internal.pageSize.getHeight();

    const pageDivs = container.querySelectorAll('div[style*="' + PAGE_W + 'px"]');
    // More reliably: select direct children
    const pageEls = Array.from(container.children);

    for (let i = 0; i < pageEls.length; i++) {
      const el = pageEls[i];
      const canvas = await window.html2canvas(el, {
        scale:           2,
        useCORS:         true,
        allowTaint:      true,
        backgroundColor: '#ffffff',
        width:           PAGE_W,
        height:          PAGE_H,
        windowWidth:     PAGE_W,
        windowHeight:    PAGE_H,
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.92);

      if (i > 0) pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, 0, pdfW, pdfH);
    }

    document.body.removeChild(container);

    // ── Download ───────────────────────────────────────────────────────────
    const date   = new Date().toISOString().slice(0, 10);
    const names  = snapshot.meta.persons.map(p => p.name.replace(/\s+/g, '-')).join('-');
    pdf.save(`incomeflow-plan-${names}-${date}.pdf`);
  }

  window.RetirePDFRender = { generate };

})();
