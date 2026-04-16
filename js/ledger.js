(function () {

  // ─────────────────────────────────────────────────────────────────────────
  // ledger.js
  //
  // Allowance ledger — tracks remaining tax headroom for a single person
  // within a projection year. Created once per person at the start of each
  // year and mutated in-place by the engine as each income priority step
  // runs, then mutated further inside withdrawalStrategy after SIPP draws.
  //
  // Mutation contract:
  //   Engine calls consumeNonSavings / consumeSavings / consumeDividends /
  //   consumeGains at each priority step BEFORE calling withdrawalStrategy.
  //   withdrawalStrategy also mutates the ledger (via consumeNonSavings after
  //   SIPP draws) so that subsequent GIA/ISA decisions reflect the updated
  //   band position. This is intentional — the ledger is a running tally,
  //   not a snapshot.
  //
  // Band positions follow UK statutory order:
  //   Non-savings -> Savings (SRS -> PSA -> taxable) -> Dividends
  //   PA is consumed in the same order.
  // ─────────────────────────────────────────────────────────────────────────

  const C = window.RetireCalc;

  // Factory
  // Creates a fresh ledger for one person at the start of a projection year.
  // effThresholds — the uprated TAX_RULES object for this year (from engine).

  function initialiseLedger(effThresholds) {
    const TAX = effThresholds;

    return {
      // Allowances (all start at full statutory value)
      paRemaining:        TAX.PA,
      srsRemaining:       TAX.srsLimit,          // Starting Rate for Savings (5000)
      psaRemaining:       TAX.psa.basic,          // Conservative start; recalculated on first savings consume
      divAllowRemaining:  TAX.dividendAllowance,  // 500
      cgtAllowRemaining:  TAX.cgtExempt,          // 3000

      // Band positions
      // basicBandRemaining = width of the 20% band not yet consumed by income.
      // Starts at (basicLimit - PA) = 37700 at 2026-27 rates.
      basicBandRemaining: Math.max(0, TAX.basicLimit - TAX.PA),

      // Accumulated income components (for band stacking)
      nonSavingsIncome:   0,   // SP + salary + SIPP taxable draw
      savingsIncome:      0,   // interest (gross, excluding ISA-exempt)
      dividendIncome:     0,   // GIA dividends (gross, on arising basis)
      realisedGains:      0,   // CGT gains accumulated this year

      // Snapshot of tax rules for this year.
      // Stored so strategy helpers can reuse without re-passing effThresholds.
      _TAX: TAX,

      // Dynamic buffer snapshot.
      // Captured at initialisation so giaIsEfficient can compute a proportionate
      // forward-looking guardrail without extra parameters.
      // Buffer = max(2000, 5% of opening basic band) — scales with uprated thresholds.
      _basicBandAtStart: Math.max(0, TAX.basicLimit - TAX.PA),
    };
  }

  // ── Mutation helpers ─────────────────────────────────────────────────────
  // Each helper advances the ledger state by one income component.
  // Call in statutory order: non-savings -> savings -> dividends -> gains.

  // Non-savings income: State Pension, salary, SIPP taxable draw.
  function consumeNonSavings(ledger, amount) {
    if (amount <= 0) return;

    ledger.nonSavingsIncome += amount;

    const paUsed = Math.min(amount, ledger.paRemaining);
    ledger.paRemaining = Math.max(0, ledger.paRemaining - paUsed);

    const taxable = amount - paUsed;
    const bandUsed = Math.min(taxable, ledger.basicBandRemaining);
    ledger.basicBandRemaining = Math.max(0, ledger.basicBandRemaining - bandUsed);

    _recalcPSA(ledger);
  }

  // Savings income: interest from GIA/Cash accounts. Not ISA (tax-exempt).
  function consumeSavings(ledger, amount) {
    if (amount <= 0) return;

    ledger.savingsIncome += amount;

    const paUsed = Math.min(amount, ledger.paRemaining);
    ledger.paRemaining = Math.max(0, ledger.paRemaining - paUsed);
    const afterPA = amount - paUsed;

    const srsUsed = Math.min(afterPA, ledger.srsRemaining);
    ledger.srsRemaining = Math.max(0, ledger.srsRemaining - srsUsed);
    const afterSRS = afterPA - srsUsed;

    const psaUsed = Math.min(afterSRS, ledger.psaRemaining);
    ledger.psaRemaining = Math.max(0, ledger.psaRemaining - psaUsed);
    const taxable = afterSRS - psaUsed;

    const bandUsed = Math.min(taxable, ledger.basicBandRemaining);
    ledger.basicBandRemaining = Math.max(0, ledger.basicBandRemaining - bandUsed);

    _recalcPSA(ledger);
  }

  // Dividend income: GIA dividends (gross, on arising basis).
  // Dividends are taxed here — do NOT include dividend yield in marginalGIARate.
  function consumeDividends(ledger, amount) {
    if (amount <= 0) return;

    ledger.dividendIncome += amount;

    const paUsed = Math.min(amount, ledger.paRemaining);
    ledger.paRemaining = Math.max(0, ledger.paRemaining - paUsed);
    const afterPA = amount - paUsed;

    const daUsed = Math.min(afterPA, ledger.divAllowRemaining);
    ledger.divAllowRemaining = Math.max(0, ledger.divAllowRemaining - daUsed);
    const taxable = afterPA - daUsed;

    const bandUsed = Math.min(taxable, ledger.basicBandRemaining);
    ledger.basicBandRemaining = Math.max(0, ledger.basicBandRemaining - bandUsed);

    _recalcPSA(ledger);
  }

  // CGT gains: realised gains from GIA withdrawals or B&I transfers.
  function consumeGains(ledger, amount) {
    if (amount <= 0) return;

    ledger.realisedGains += amount;

    const exempt = Math.min(amount, ledger.cgtAllowRemaining);
    ledger.cgtAllowRemaining = Math.max(0, ledger.cgtAllowRemaining - exempt);

    // Gains stack on top of income for CGT band purposes but do not consume
    // the income tax basic band. Band position derived at tax calc time.
    // No basicBandRemaining mutation here.
  }

  // ── Query helpers ─────────────────────────────────────────────────────────

  // Marginal income tax rate on the next £1 of non-savings income.
  function marginalNonSavingsRate(ledger) {
    if (ledger.paRemaining > 0)        return 0;
    if (ledger.basicBandRemaining > 0) return ledger._TAX.nonSavingsRates.basic;  // 20%
    return ledger._TAX.nonSavingsRates.higher;                                     // 40%
  }

  // Marginal CGT rate on the next £1 of GIA withdrawal.
  // Only CGT is considered — dividends are already taxed on an arising basis
  // upstream via consumeDividends() and must not be double-counted here.
  // gainRatio — fraction of GIA balance that is unrealised gain (0-1).
  function marginalGIARate(ledger, gainRatio) {
    const TAX = ledger._TAX;

    if (gainRatio <= 0) return 0;              // no gains — return of capital, 0% CGT
    if (ledger.cgtAllowRemaining > 0) return 0; // within 3000 exemption
    if (ledger.basicBandRemaining > 0) return TAX.cgtRates.basic;  // 18%
    return TAX.cgtRates.higher;                                      // 24%
  }

  // Returns true if drawing from GIA is tax-efficient under the given strategy.
  // proposedDraw — size of the GIA draw being considered (for forward-looking guardrail).
  // gainRatio    — unrealised gain fraction of GIA balance (0-1).
  function giaIsEfficient(ledger, strategy, gainRatio, proposedDraw) {
    const rate = marginalGIARate(ledger, gainRatio);
    const TAX  = ledger._TAX;

    switch (strategy) {
      case 'isaFirst':
        // Use GIA only if completely tax-free (CGT within allowance)
        return rate === 0;

      case 'sippFirst':
        // Use GIA freely within basic-rate CGT band — switch only at higher-rate CGT
        return rate < TAX.cgtRates.higher;

      case 'balanced':
      default: {
        // Forward-looking guardrail: switch to ISA if this draw would push us
        // within the buffer of the higher-rate threshold.
        // Buffer = max(2000, 5% of opening basic band) — scales with uprated thresholds.
        const buffer = Math.max(2000, ledger._basicBandAtStart * 0.05);
        const drawAmount = proposedDraw || 0;
        const bandAfterDraw = ledger.basicBandRemaining - drawAmount;
        if (bandAfterDraw < buffer) return false;
        return rate < TAX.cgtRates.higher;
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  function _recalcPSA(ledger) {
    const TAX         = ledger._TAX;
    const totalIncome = ledger.nonSavingsIncome + ledger.savingsIncome + ledger.dividendIncome;
    const taxableTotal = Math.max(0, totalIncome - TAX.PA);

    const basicBandWidth  = TAX.basicLimit - TAX.PA;
    const higherBandLimit = TAX.additionalThreshold - TAX.PA;

    let newPSA;
    if (taxableTotal <= basicBandWidth)       newPSA = TAX.psa.basic;      // 1000
    else if (taxableTotal <= higherBandLimit) newPSA = TAX.psa.higher;     // 500
    else                                       newPSA = TAX.psa.additional; // 0

    // Only ever reduce PSA — never restore once degraded within a year.
    ledger.psaRemaining = Math.min(ledger.psaRemaining, newPSA);
  }

  window.RetireLedger = {
    initialiseLedger,
    consumeNonSavings,
    consumeSavings,
    consumeDividends,
    consumeGains,
    marginalNonSavingsRate,
    marginalGIARate,
    giaIsEfficient,
  };

})();
