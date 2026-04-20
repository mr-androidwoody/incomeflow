/**
 * mc-assumptions.js
 *
 * Market return and volatility assumptions for the Monte Carlo engine.
 * Registers window.RetireMCAssumptions.
 *
 * These assumptions are INDEPENDENT of the user's conservative planning rate.
 * The deterministic engine uses whatever growth rate the user enters (deliberately
 * conservative). The MC engine uses these historically-grounded figures so that
 * simulated paths reflect realistic market behaviour for the portfolio's actual
 * asset allocation.
 *
 * The function getMCAssumptions() accepts the portfolio's actual weighted
 * allocation (equity %, bond %, cashlike %, cash %) computed directly from the
 * account portfolio via summarisePortfolio() in app.js — no band rounding or
 * snapping. The blended return and vol are calculated precisely from real weights.
 *
 * ── Asset class assumptions (nominal, annualised) ─────────────────────────
 * Sources: Vanguard Capital Markets Model 2024,
 *          BlackRock Capital Market Assumptions 2024
 *
 *   Global equities (MSCI World, GBP):  8.00% return, 16.0% vol
 *   Global bonds (agg, GBP hedged):     4.50% return,  7.0% vol
 *   Cashlike (money market / QMMF):     3.50% return,  1.0% vol
 *   Cash (uninvested):                  0.00% return,  0.0% vol
 *
 * Correlation assumptions:
 *   Equities / Bonds:    0.00  (post-2020 regime — no longer reliably negative)
 *   Equities / Cashlike: 0.00
 *   Bonds    / Cashlike: 0.20  (modest positive — both rate-sensitive)
 *   All others:          0.00
 *
 * ── Fee deduction ─────────────────────────────────────────────────────────
 * ANNUAL_FEE is deducted from the blended gross return before passing to the
 * MC worker. It represents blended platform + fund TER across the portfolio.
 * Update this figure if your all-in cost changes.
 *
 *   0.22% = approx blended cost across Vanguard SIPP/ISA (~0.37% all-in)
 *           and Trading 212 QMMF / direct holdings (~0% platform cost).
 *
 * ── How to update ─────────────────────────────────────────────────────────
 * 1. Adjust ANNUAL_FEE if platform/fund costs change.
 * 2. Adjust EQ_RETURN, BD_RETURN, CL_RETURN if your long-run return view changes.
 * 3. Adjust EQ_VOL, BD_VOL if volatility assumptions change.
 * 4. Adjust correlations if the equity/bond relationship shifts.
 */

(function () {
  'use strict';

  // ── Asset class return assumptions (nominal, annualised) ──────────────────
  const EQ_RETURN  = 0.065;   // Global equities
  const BD_RETURN  = 0.040;   // Global bonds
  const CL_RETURN  = 0.025;   // Cashlike / money market
  const CA_RETURN  = 0.000;   // Uninvested cash

  // ── Asset class volatility assumptions (annualised) ───────────────────────
  const EQ_VOL     = 0.160;   // Global equities
  const BD_VOL     = 0.070;   // Global bonds
  const CL_VOL     = 0.015;   // Cashlike
  const CA_VOL     = 0.000;   // Cash

  // ── Correlation assumptions ───────────────────────────────────────────────
  const CORR_EQ_BD = 0.00;    // Equities / bonds (post-2020 regime)
  const CORR_EQ_CL = 0.00;    // Equities / cashlike
  const CORR_EQ_CA = 0.00;    // Equities / cash
  const CORR_BD_CL = 0.20;    // Bonds / cashlike (modest positive, rate-sensitive)
  const CORR_BD_CA = 0.00;    // Bonds / cash
  const CORR_CL_CA = 0.00;    // Cashlike / cash

  // ── Fee deduction ─────────────────────────────────────────────────────────
  const ANNUAL_FEE = 0.0022;  // 0.22% blended platform + fund TER

  // ── Inflation volatility ──────────────────────────────────────────────────
  const INFLATION_VOL = 0.015; // Passed through to MC worker unchanged

  /**
   * Compute blended return and vol from actual portfolio weights.
   * Weights are normalised to sum to 1 internally.
   */
  function _blend(eqPct, bdPct, clPct, caPct) {
    const total = eqPct + bdPct + clPct + caPct;
    const weq = total > 0 ? eqPct / total : 0;
    const wbd = total > 0 ? bdPct / total : 0;
    const wcl = total > 0 ? clPct / total : 0;
    const wca = total > 0 ? caPct / total : 0;

    const grossReturn =
      weq * EQ_RETURN +
      wbd * BD_RETURN +
      wcl * CL_RETURN +
      wca * CA_RETURN;

    const netReturn = grossReturn - ANNUAL_FEE;

    // Full 4-asset portfolio variance with all pairwise correlations
    const variance =
      Math.pow(weq * EQ_VOL, 2) +
      Math.pow(wbd * BD_VOL, 2) +
      Math.pow(wcl * CL_VOL, 2) +
      Math.pow(wca * CA_VOL, 2) +
      2 * weq * wbd * CORR_EQ_BD * EQ_VOL * BD_VOL +
      2 * weq * wcl * CORR_EQ_CL * EQ_VOL * CL_VOL +
      2 * weq * wca * CORR_EQ_CA * EQ_VOL * CA_VOL +
      2 * wbd * wcl * CORR_BD_CL * BD_VOL * CL_VOL +
      2 * wbd * wca * CORR_BD_CA * BD_VOL * CA_VOL +
      2 * wcl * wca * CORR_CL_CA * CL_VOL * CA_VOL;

    return {
      grossReturn,
      netReturn,
      vol: Math.sqrt(Math.max(0, variance)),
    };
  }

  /**
   * Return MC assumptions for the portfolio's actual asset allocation.
   *
   * All percentages come directly from summarisePortfolio().overallAllocation
   * in app.js. No band rounding — blended return and vol are computed precisely
   * from the real weights.
   *
   * @param {number} equityPct   - overall portfolio equities %
   * @param {number} bondPct     - overall portfolio bonds %
   * @param {number} cashlikePct - overall portfolio cashlike %
   * @param {number} cashPct     - overall portfolio cash %
   *
   * @returns {{ growth: number, equityVol: number, inflationVol: number }}
   *   growth       - net-of-fee blended nominal return (MC drift parameter)
   *   equityVol    - blended portfolio vol (not pure equity vol)
   *   inflationVol - inflation vol assumption
   */
  function getMCAssumptions(equityPct, bondPct, cashlikePct, cashPct) {
    const eq = Math.max(0, equityPct   || 0);
    const bd = Math.max(0, bondPct     || 0);
    const cl = Math.max(0, cashlikePct || 0);
    const ca = Math.max(0, cashPct     || 0);

    const blend = _blend(eq, bd, cl, ca);

    return {
      growth:       blend.netReturn,
      equityVol:    blend.vol,
      inflationVol: INFLATION_VOL,
    };
  }

  /**
   * Return the full breakdown for display or debugging.
   * Call from the browser console: RetireMCAssumptions.getMCAssumptionsDetail(87, 6, 5, 2)
   *
   * @param {number} equityPct
   * @param {number} bondPct
   * @param {number} cashlikePct
   * @param {number} cashPct
   * @returns {object}
   */
  function getMCAssumptionsDetail(equityPct, bondPct, cashlikePct, cashPct) {
    const eq = Math.max(0, equityPct   || 0);
    const bd = Math.max(0, bondPct     || 0);
    const cl = Math.max(0, cashlikePct || 0);
    const ca = Math.max(0, cashPct     || 0);

    const blend         = _blend(eq, bd, cl, ca);
    const varianceDrag  = 0.5 * Math.pow(blend.vol, 2);
    const geometricMean = blend.netReturn - varianceDrag;

    return {
      weights:        { equityPct: eq, bondPct: bd, cashlikePct: cl, cashPct: ca },
      grossReturn:    blend.grossReturn,
      annualFee:      ANNUAL_FEE,
      netReturn:      blend.netReturn,
      vol:            blend.vol,
      varianceDrag,
      geometricMean,
      inflationVol:   INFLATION_VOL,
    };
  }

  window.RetireMCAssumptions = { getMCAssumptions, getMCAssumptionsDetail };

})();
