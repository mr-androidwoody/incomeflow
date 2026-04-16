(function () {

  // ─────────────────────────────────────────────────────────────────────────
  // ledger.js
  //
  // Allowance ledger — tracks remaining tax headroom for a single person
  // within a projection year. Created once per person at the start of each
  // year and mutated in-place by the engine as each income priority step
  // runs. Passed (read-only) into withdrawalStrategy so it can make
  // tax-aware GIA vs ISA decisions without recomputing income from scratch.
  //
  // Mutation contract:
  //   Engine calls consumeNonSavings / consumeSavings / consumeDividends /
  //   consumeGains at each priority step BEFORE calling withdrawalStrategy.
  //   withdrawalStrategy reads the ledger but does NOT mutate it — the engine
  //   updates it after the draw if needed for downstream tax calculations.
  //
  // Band positions follow UK statutory order:
  //   Non-savings → Savings (SRS → PSA → taxable) → Dividends
  //   PA is consumed in the same order.
  // ─────────────────────────────────────────────────────────────────────────

  const C = window.RetireCalc;

  // ── Factory ──────────────────────────────────────────────────────────────
  // Creates a fresh ledger for one person at the start of a projection year.
  // effThresholds — the uprated TAX_RULES object for this year (from engine).
  // atOrAboveSPA  — boolean; affects PSA tier (not NI — engine handles NI separately).

  function initialiseLedger(effThresholds) {
    const TAX = effThresholds;

    return {
      // ── Allowances (all start at full statutory value) ──
      paRemaining:        TAX.PA,
      srsRemaining:       TAX.srsLimit,          // Starting Rate for Savings (£5,000)
      psaRemaining:       TAX.psa.basic,          // Conservative start; recalculated on first savings consume
      divAllowRemaining:  TAX.dividendAllowance,  // £500
      cgtAllowRemaining:  TAX.cgtExempt,          // £3,000

      // ── Band positions ──
      // basicBandRemaining = width of the 20% band not yet consumed by income.
      // Starts at (basicLimit − PA) = £37,700 at 2026-27 rates.
      basicBandRemaining: Math.max(0, TAX.basicLimit - TAX.PA),

      // ── Accumulated income components (for band stacking) ──
      nonSavingsIncome:   0,   // SP + salary + SIPP taxable draw
      savingsIncome:      0,   // interest (gross, including ISA-exempt portions)
      dividendIncome:     0,   // GIA dividends (gross)
      realisedGains:      0,   // CGT gains accumulated this year

      // ── Snapshot of tax rules for this year ──
      // Stored so withdrawalStrategy helpers can reuse without re-passing effThresholds.
      _TAX: TAX,

      // ── Dynamic buffer snapshot ──
      // Captured at initialisation so giaIsEfficient can compute a proportionate
      // forward-looking guardrail without extra parameters.
      // Buffer = max(£2,000, 5% of opening basic band) — scales with uprated thresholds.
      _basicBandAtStart: Math.max(0, TAX.basicLimit - TAX.PA),
    };
  }

  // ── Mutation helpers ─────────────────────────────────────────────────────
  // Each helper advances the ledger state by one income component.
  // Call them in statutory order: non-savings → savings → dividends → gains.

  // Non-savings income: State Pension, salary, SIPP taxable draw.
  function consumeNonSavings(ledger, amount) {
    if (amount <= 0) return;
    const TAX = ledger._TAX;

    ledger.nonSavingsIncome += amount;

    // PA consumption
    const paUsed = Math.min(amount, ledger.paRemaining);
    ledger.paRemaining = Math.max(0, ledger.paRemaining - paUsed);

    // Basic band consumption (taxable portion only, i.e. after PA)
    const taxable = amount - paUsed;
    const bandUsed = Math.min(taxable, ledger.basicBandRemaining);
    ledger.basicBandRemaining = Math.max(0, ledger.basicBandRemaining - bandUsed);

    // PSA tier degrades as non-savings income pushes into higher rate.
    // Recalculate based on total income seen so far.
    _recalcPSA(ledger);
  }

  // Savings income: interest from GIA/Cash interest accounts.
  // ISA interest should NOT be passed here (tax-exempt).
  function consumeSavings(ledger, amount) {
    if (amount <= 0) return;

    ledger.savingsIncome += amount;

    // PA consumption (savings income absorbed after non-savings)
    const paUsed = Math.min(amount, ledger.paRemaining);
    ledger.paRemaining = Math.max(0, ledger.paRemaining - paUsed);
    const afterPA = amount - paUsed;

    // Starting Rate for Savings (0% band, up to £5,000 — only available
    // when non-savings taxable income is below £5,000)
    const srsUsed = Math.min(afterPA, ledger.srsRemaining);
    ledger.srsRemaining = Math.max(0, ledger.srsRemaining - srsUsed);
    const afterSRS = afterPA - srsUsed;

    // PSA
    const psaUsed = Math.min(afterSRS, ledger.psaRemaining);
    ledger.psaRemaining = Math.max(0, ledger.psaRemaining - psaUsed);
    const taxable = afterSRS - psaUsed;

    // Basic band
    const bandUsed = Math.min(taxable, ledger.basicBandRemaining);
    ledger.basicBandRemaining = Math.max(0, ledger.basicBandRemaining - bandUsed);

    _recalcPSA(ledger);
  }

  // Dividend income: GIA dividends (gross, on arising basis).
  function consumeDividends(ledger, amount) {
    if (amount <= 0) return;

    ledger.dividendIncome += amount;

    // PA consumption (dividends absorbed after non-savings and savings)
    const paUsed = Math.min(amount, ledger.paRemaining);
    ledger.paRemaining = Math.max(0, ledger.paRemaining - paUsed);
    const afterPA = amount - paUsed;

    // Dividend allowance (£500)
    const daUsed = Math.min(afterPA, ledger.divAllowRemaining);
    ledger.divAllowRemaining = Math.max(0, ledger.divAllowRemaining - daUsed);
    const taxable = afterPA - daUsed;

    // Basic band (dividends stack last)
    const bandUsed = Math.min(taxable, ledger.basicBandRemaining);
    ledger.basicBandRemaining = Math.max(0, ledger.basicBandRemaining - bandUsed);

    _recalcPSA(ledger);
  }

  // CGT gains: realised gains from GIA withdrawals or B&I transfers.
  function consumeGains(ledger, amount) {
    if (amount <= 0) return;

    ledger.realisedGains += amount;

    // CGT allowance
    const exempt = Math.min(amount, ledger.cgtAllowRemaining);
    ledger.cgtAllowRemaining = Math.max(0, ledger.cgtAllowRemaining - exempt);

    // Note: gains stack ON TOP of income for CGT band purposes but do not
    // consume the income tax basic band itself. The CGT band position is
    // derived at calculation time from basicBandRemaining + income stacking.
    // No basicBandRemaining mutation here — see calcCGT in calculator.js.
  }

  // ── Query helpers ─────────────────────────────────────────────────────────
  // Used by withdrawalStrategy to decide GIA vs ISA.

  // Returns the marginal income tax rate on the next £1 of non-savings income
  // (e.g. a further SIPP draw). Used to gate SIPP draws at band boundaries.
  function marginalNonSavingsRate(ledger) {
    if (ledger.paRemaining > 0)           return 0;
    if (ledger.basicBandRemaining > 0)    return ledger._TAX.nonSavingsRates.basic;    // 20%
    return ledger._TAX.nonSavingsRates.higher;                                          // 40%
  }

  // Returns the effective marginal rate on the next £1 of GIA withdrawal,
  // accounting for whether that £1 is a gain, dividend, or neither.
  // gainRatio    — fraction of GIA balance that is unrealised gain (0–1)
  // dividendYield — annual yield of GIA as fraction (e.g. 0.015)
  // drawAmount   — size of the proposed GIA draw (used to estimate composition)
  function marginalGIARate(ledger, gainRatio, dividendYield) {
    const TAX = ledger._TAX;

    // Estimate what the next £1 of GIA draw consists of:
    //   - A portion is realised gain
    //   - A portion is dividend (already taxed on arising — no additional tax on draw)
    //   - Remainder is return of capital (0% tax)
    // For simplicity we treat the gain portion and assess its marginal CGT rate.

    // CGT marginal rate on next £1 of gain
    let cgtRate = 0;
    if (gainRatio > 0) {
      if (ledger.cgtAllowRemaining > 0) {
        cgtRate = 0; // within allowance
      } else if (ledger.basicBandRemaining > 0) {
        cgtRate = TAX.cgtRates.basic;   // 18%
      } else {
        cgtRate = TAX.cgtRates.higher;  // 24%
      }
    }

    // Dividend marginal rate on next £1 of dividend income
    // (dividends are taxed on arising basis — a GIA draw doesn't re-trigger
    //  dividend tax, but we use this to assess the ongoing dividend tax cost
    //  of holding GIA vs ISA)
    let divRate = 0;
    if (dividendYield > 0) {
      if (ledger.divAllowRemaining > 0) {
        divRate = 0;
      } else if (ledger.basicBandRemaining > 0) {
        divRate = TAX.dividendRates.basic;   // 8.75%
      } else {
        divRate = TAX.dividendRates.higher;  // 33.75%
      }
    }

    // Blended marginal rate weighted by gain and dividend fractions
    return gainRatio * cgtRate + dividendYield * divRate;
  }

  // Returns true if drawing from GIA is tax-efficient under the given strategy.
  // strategy    — 'balanced' | 'isaFirst' | 'sippFirst'
  // gainRatio   — unrealised gain fraction of GIA
  // dividendYield — GIA dividend yield (fraction)
  function giaIsEfficient(ledger, strategy, gainRatio, dividendYield) {
    const rate = marginalGIARate(ledger, gainRatio, dividendYield);
    const TAX  = ledger._TAX;

    switch (strategy) {
      case 'isaFirst':
        // Use GIA only if completely tax-free (within all allowances)
        return rate === 0;

      case 'sippFirst':
        // Use GIA freely within basic rate — switch to ISA only approaching higher rate
        // Threshold: basic rate CGT (18%) or income tax (20%) are both acceptable
        // Switch when hitting higher-rate CGT (24%) or dividend higher rate (33.75%)
        return rate < TAX.cgtRates.higher && rate < TAX.dividendRates.higher;

      case 'balanced':
      default: {
        // Switch to ISA before hitting higher rate — accept basic-rate CGT (18%)
        // and dividend basic rate (8.75%) but not higher-rate equivalents.
        // Dynamic forward-looking buffer: max(£2,000, 5% of opening basic band).
        // Scales proportionately if thresholds are uprated in later projection years.
        const buffer = Math.max(2000, ledger._basicBandAtStart * 0.05);
        const approachingHigherRate = ledger.basicBandRemaining < buffer;
        if (approachingHigherRate) return false;
        return rate < TAX.cgtRates.higher && rate < TAX.dividendRates.higher;
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  // PSA tier depends on total income — recalculate after each component.
  function _recalcPSA(ledger) {
    const TAX          = ledger._TAX;
    const totalIncome  = ledger.nonSavingsIncome + ledger.savingsIncome + ledger.dividendIncome;
    const taxableTotal = Math.max(0, totalIncome - TAX.PA);

    const basicBandWidth  = TAX.basicLimit - TAX.PA;
    const higherBandLimit = TAX.additionalThreshold - TAX.PA;

    let newPSA;
    if (taxableTotal <= basicBandWidth)   newPSA = TAX.psa.basic;    // £1,000
    else if (taxableTotal <= higherBandLimit) newPSA = TAX.psa.higher; // £500
    else                                   newPSA = TAX.psa.additional; // £0

    // Only ever reduce PSA — never restore it once degraded within a year.
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
