(function () {
  const D = window.RetireData;

  // ─────────────────────────────────────────────
  // CONSTANTS
  // ─────────────────────────────────────────────
  // 25% of a SIPP withdrawal is tax-free (pension commencement lump sum);
  // the remaining 75% is taxable as non-savings income.
  const SIPP_TAXABLE_RATIO = 0.75;

  // ─────────────────────────────────────────────
  // TAX RULE HELPERS
  // ─────────────────────────────────────────────
  function getTaxRulesForYear(year) {
    return year <= 2026 ? D.TAX_RULES['2026-27'] : D.TAX_RULES['2027-28+'];
  }

  function upratedTaxRules(baseRules, uprateFactor) {
    return {
      ...baseRules,
      // Uprated: income tax and NI thresholds are typically CPI/earnings linked
      PA:                   baseRules.PA                   * uprateFactor,
      basicLimit:           baseRules.basicLimit           * uprateFactor,
      additionalThreshold:  baseRules.additionalThreshold  * uprateFactor,
      taperStart:           baseRules.taperStart           * uprateFactor,
      ni: {
        primaryThreshold:   baseRules.ni.primaryThreshold   * uprateFactor,
        upperEarningsLimit: baseRules.ni.upperEarningsLimit * uprateFactor,
        mainRate:           baseRules.ni.mainRate,
        upperRate:          baseRules.ni.upperRate,
      },
      // NOT uprated: statutory fixed allowances set by parliament, not inflation-linked
      // cgtExempt (£3,000), srsLimit (£5,000), dividendAllowance (£500), psa (£1,000/£500/£0)
      cgtExempt:         baseRules.cgtExempt,
      srsLimit:          baseRules.srsLimit,
      dividendAllowance: baseRules.dividendAllowance,
      psa: {
        basic:      baseRules.psa.basic,
        higher:     baseRules.psa.higher,
        additional: baseRules.psa.additional,
      },
    };
  }

  // ─────────────────────────────────────────────
  // PORTFOLIO SUMMARY
  // ─────────────────────────────────────────────
  function summarisePortfolio(accounts) {
    const wrapperTotals = { ISA: 0, SIPP: 0, GIA: 0, Cash: 0 };
    let total = 0;
    const overallAllocation = { equities: 0, bonds: 0, cashlike: 0, cash: 0 };

    accounts.forEach((acc) => {
      const val = acc.value || 0;
      total += val;
      wrapperTotals[acc.wrapper] = (wrapperTotals[acc.wrapper] || 0) + val;
      Object.keys(overallAllocation).forEach((cls) => {
        overallAllocation[cls] += val * ((acc.alloc?.[cls] || 0) / 100);
      });
    });

    if (total > 0) {
      Object.keys(overallAllocation).forEach((cls) => {
        overallAllocation[cls] = (overallAllocation[cls] / total) * 100;
      });
    }

    return {
      total,
      wrapperTotals,
      overallAllocation,
      overallPct: Object.values(overallAllocation).reduce((a, b) => a + b, 0),
    };
  }

  // ─────────────────────────────────────────────
  // TAX CALCULATIONS
  // ─────────────────────────────────────────────
  // taperedPA is optional: pass income.taperedPA for correctness when the person's PA
  // has been reduced by the £100k taper. Falls back to TAX.PA (= no taper in effect).
  // Basic band = basicLimit − effectivePA (the width of the 20% band available for CGT stacking).
  function calcCGT(taxableIncomeAfterPA, taxableGain, TAX, taperedPA) {
    if (taxableGain <= 0) return 0;
    const effectivePA    = (taperedPA !== undefined && taperedPA !== null) ? taperedPA : TAX.PA;
    const basicBand      = Math.max(0, TAX.basicLimit - effectivePA);
    const basicUsed      = Math.min(Math.max(0, taxableIncomeAfterPA), basicBand);
    const basicRemaining = Math.max(0, basicBand - basicUsed);
    const atBasic        = Math.min(taxableGain, basicRemaining);
    const atHigher       = Math.max(0, taxableGain - atBasic);
    return atBasic * TAX.cgtRates.basic + atHigher * TAX.cgtRates.higher;
  }

  function calcEmployeeNI(employmentIncome, TAX, atOrAboveStatePensionAge) {
    if (atOrAboveStatePensionAge || employmentIncome <= 0) return 0;
    const pt       = TAX.ni.primaryThreshold;
    const uel      = TAX.ni.upperEarningsLimit;
    const mainBand = Math.max(0, Math.min(employmentIncome, uel) - pt);
    const upperBand = Math.max(0, employmentIncome - uel);
    return mainBand * TAX.ni.mainRate + upperBand * TAX.ni.upperRate;
  }

  function calcIncomeTaxDetailed(nonSavings, savings, dividends, TAX) {
    nonSavings = nonSavings || 0;
    savings    = savings    || 0;
    dividends  = dividends  || 0;

    const totalIncome = nonSavings + savings + dividends;
    if (totalIncome <= 0) {
      return { tax: 0, taxableIncomeAfterPA: 0, pa: 0, paUsed: 0,
               nsNet: 0, savNet: 0, divNet: 0,
               srsCover: 0, savTaxable: 0, divTaxable: 0,
               psa: 0, nsTax: 0, savTax: 0, divTax: 0 };
    }

    // PA taper: £1 reduction per £2 over £100k, floored to whole pounds (HMRC spec).
    // e.g. income £100,001 → floor(1/2) = 0 reduction, PA stays £12,570.
    const reduction = Math.floor(Math.max(0, (totalIncome - TAX.taperStart) / 2));
    const pa = totalIncome > TAX.taperStart
      ? Math.max(0, TAX.PA - reduction)
      : TAX.PA;

    let paRem = pa;
    const nsNet  = Math.max(0, nonSavings - paRem); paRem = Math.max(0, paRem - nonSavings);
    const savNet = Math.max(0, savings    - paRem); paRem = Math.max(0, paRem - savings);
    const divNet = Math.max(0, dividends  - paRem);

    const srsAvail   = Math.max(0, TAX.srsLimit - nsNet);
    const srsCover   = Math.min(savNet, srsAvail);
    const savAfterSRS = savNet - srsCover;

    // PSA tier is determined by whether ANY taxable income (after PA) falls in the higher
    // rate band — HMRC explicitly includes dividend income in this assessment (LITRG).
    // We compare against (basicLimit - pa) and (additionalThreshold - pa) — using the
    // *tapered* PA — because the band boundaries widen when PA is reduced by the taper.
    // Using the untagered TAX.PA constant here would misclassify people in the upper taper
    // zone (roughly £112k–£125k) as additional-rate PSA payers when they are still higher-rate.
    const taxableForPSA = nsNet + savAfterSRS + divNet;
    const psa = taxableForPSA <= (TAX.basicLimit - pa)          ? TAX.psa.basic
              : taxableForPSA <= (TAX.additionalThreshold - pa) ? TAX.psa.higher
              : TAX.psa.additional;
    const psaCover   = Math.min(savAfterSRS, psa);
    const savTaxable = Math.max(0, savAfterSRS - psaCover);
    const divTaxable = Math.max(0, divNet - TAX.dividendAllowance);

    const basicBand  = Math.max(0, TAX.basicLimit          - pa);
    const higherBand = Math.max(0, TAX.additionalThreshold - TAX.basicLimit);

    let nsTax = 0;
    { let r = nsNet;
      const b = Math.min(r, basicBand); nsTax += b * TAX.nonSavingsRates.basic; r -= b;
      if (r > 0) { const h = Math.min(r, higherBand); nsTax += h * TAX.nonSavingsRates.higher; r -= h;
        if (r > 0) nsTax += r * TAX.nonSavingsRates.additional; } }

    let savTax = 0;
    if (savTaxable > 0) {
      let r = savTaxable;
      const bLeft = Math.max(0, basicBand - nsNet);
      const b = Math.min(r, bLeft); savTax += b * TAX.savingsRates.basic; r -= b;
      if (r > 0) { const hLeft = Math.max(0, higherBand - Math.max(0, nsNet - basicBand));
        const h = Math.min(r, hLeft); savTax += h * TAX.savingsRates.higher; r -= h;
        if (r > 0) savTax += r * TAX.savingsRates.additional; } }

    let divTax = 0;
    if (divTaxable > 0) {
      let r = divTaxable;
      const used  = nsNet + savNet;
      const bLeft = Math.max(0, basicBand - used);
      const b = Math.min(r, bLeft); divTax += b * TAX.dividendRates.basic; r -= b;
      if (r > 0) { const hLeft = Math.max(0, higherBand - Math.max(0, used - basicBand));
        const h = Math.min(r, hLeft); divTax += h * TAX.dividendRates.higher; r -= h;
        if (r > 0) divTax += r * TAX.dividendRates.additional; } }

    return {
      tax: nsTax + savTax + divTax,
      taxableIncomeAfterPA: nsNet + savNet + divNet,
      pa,
      taperedPA: pa,   // explicit alias — pa is already the tapered value; callers needing
                       // the effective basic band should use (basicLimit - taperedPA), not
                       // (basicLimit - TAX.PA), to get the correct width after taper.
      paUsed: pa - paRem,
      nsNet, savNet, divNet,
      srsCover,
      savTaxable, divTaxable,
      psa,
      nsTax, savTax, divTax,
    };
  }

  function calcIncomeTax(nonSavings, savings, dividends, TAX) {
    return calcIncomeTaxDetailed(nonSavings, savings, dividends, TAX).tax;
  }

  // ─────────────────────────────────────────────
  // PROJECTION PRIMITIVES
  // ─────────────────────────────────────────────
  function interestEffective(annualPct) {
    const daily = annualPct / 100 / 365;
    return Math.pow(1 + daily, 365) - 1;
  }

  function withdraw(balances, order, needed) {
    const drawn = { Cash: 0, GIA: 0, SIPP: 0, ISA: 0, sippTaxable: 0 };
    let rem = needed;
    for (const w of order) {
      if (rem <= 0) break;
      const avail = balances[w] || 0;
      if (avail <= 0) continue;
      const take  = Math.min(avail, rem);
      drawn[w]   += take;
      balances[w] -= take;
      rem         -= take;
      if (w === 'SIPP') drawn.sippTaxable += take * SIPP_TAXABLE_RATIO;
    }
    return drawn;
  }

  function growBalances(b, growthRate) {
    b.Cash = b.Cash || 0;
    b.GIA  = (b.GIA  || 0) * (1 + growthRate);
    b.SIPP = (b.SIPP || 0) * (1 + growthRate);
    b.ISA  = (b.ISA  || 0) * (1 + growthRate);
  }

  function totalBal(b) {
    return (b.Cash || 0) + (b.GIA || 0) + (b.SIPP || 0) + (b.ISA || 0);
  }

  window.RetireCalc = {
    SIPP_TAXABLE_RATIO,
    getTaxRulesForYear,
    upratedTaxRules,
    summarisePortfolio,
    calcCGT,
    calcEmployeeNI,
    calcIncomeTaxDetailed,
    calcIncomeTax,
    interestEffective,
    withdraw,
    growBalances,
    totalBal,
  };
})();
