/**
 * growth-assumptions.js
 *
 * Asset class nominal return assumptions for the deterministic planning engine.
 * Registers window.RetireGrowthAssumptions.
 *
 * These assumptions are used to suggest a nominal growth rate on the Growth tab
 * based on the user's actual portfolio allocation. They are INDEPENDENT of the
 * MC engine assumptions in mc-assumptions.js but use the same nominal basis.
 *
 * All returns here are NOMINAL (before inflation) and GROSS of the 0.22%/yr fee.
 * The deterministic engine in engine.js applies growth as a nominal rate and
 * handles inflation separately via cumInfl — so the suggested rate must be
 * nominal to match. ANNUAL_FEE is deducted here to derive the suggestion shown
 * to the user (the engine deducts it again internally via mgmtFee).
 *
 * ── Asset class nominal return assumptions (gross, annualised) ────────────
 * Sources: Vanguard Capital Markets Model 2024, BlackRock CMA 2024.
 * Assumes 2.5% inflation. Real midpoints split the difference between
 * conservative long-run DMS figures and forward-looking CMA estimates.
 *
 *   Global equities (MSCI World / VWRL):  8.00% nominal gross  (~6.0% real)
 *   Global bonds (agg, GBP hedged):       4.75% nominal gross  (~2.25% real)
 *   Cashlike (money market / QMMF):       3.25% nominal gross  (~0.75% real)
 *   Cash (uninvested):                    0.00% nominal gross  (~-2.5% real drag)
 *
 * ── Fee deduction ─────────────────────────────────────────────────────────
 * ANNUAL_FEE is deducted from the blended gross nominal return to produce the
 * suggested rate shown in the UI. Matches mc-assumptions.js.
 *
 *   0.22% = approx blended cost across Vanguard SIPP/ISA and Trading 212.
 *
 * ── How to update ─────────────────────────────────────────────────────────
 * 1. Adjust EQ_NOM, BD_NOM, CL_NOM if your long-run return view changes.
 * 2. Adjust ANNUAL_FEE if platform/fund costs change.
 * 3. CA_NOM stays at 0 — uninvested cash earns no nominal return.
 */

(function () {
  'use strict';

  // ── Asset class nominal return assumptions (gross, annualised) ────────────
  const EQ_NOM = 0.0650;   // Global equities (MSCI World / VWRL)
  const BD_NOM = 0.0400;   // Global bonds
  const CL_NOM = 0.0250;   // Cashlike / money market
  const CA_NOM = 0.0000;   // Uninvested cash

  // ── Fee deduction ─────────────────────────────────────────────────────────
  const ANNUAL_FEE = 0.0022; // 0.22% blended platform + fund TER

  /**
   * Compute blended net nominal return from actual portfolio weights.
   * Weights are normalised to sum to 1 internally.
   *
   * @param {number} equityPct   - overall portfolio equities %
   * @param {number} bondPct     - overall portfolio bonds %
   * @param {number} cashlikePct - overall portfolio cashlike %
   * @param {number} cashPct     - overall portfolio cash %
   *
   * @returns {{ rate: number, equityPct: number, bondPct: number, cashlikePct: number, cashPct: number }}
   *   rate        - blended net nominal return (decimal)
   *   equityPct   - normalised equity weight (for display)
   *   bondPct     - normalised bond weight (for display)
   *   cashlikePct - normalised cashlike weight (for display)
   *   cashPct     - normalised cash weight (for display)
   */
  function getSuggestedGrowth(equityPct, bondPct, cashlikePct, cashPct) {
    const eq = Math.max(0, equityPct   || 0);
    const bd = Math.max(0, bondPct     || 0);
    const cl = Math.max(0, cashlikePct || 0);
    const ca = Math.max(0, cashPct     || 0);

    const total = eq + bd + cl + ca;
    if (total <= 0) return null;

    const weq = eq / total;
    const wbd = bd / total;
    const wcl = cl / total;
    const wca = ca / total;

    const grossNominal =
      weq * EQ_NOM +
      wbd * BD_NOM +
      wcl * CL_NOM +
      wca * CA_NOM;

    const netNominal = grossNominal - ANNUAL_FEE;

    return {
      rate:        netNominal,
      equityPct:   Math.round(weq * 100),
      bondPct:     Math.round(wbd * 100),
      cashlikePct: Math.round(wcl * 100),
      cashPct:     Math.round(wca * 100),
    };
  }

  window.RetireGrowthAssumptions = { getSuggestedGrowth };

})();
