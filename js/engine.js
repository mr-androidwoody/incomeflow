(function () {
  const D = window.RetireData;
  const C = window.RetireCalc;
  const calculateTax = window.calculateTax; 

  function mapTaxRules(TAX) {
    return {
      personalAllowance: TAX.PA,
      basicRateLimit: TAX.basicLimit,
      higherRateLimit: TAX.additionalThreshold,

      incomeTaxRates: TAX.nonSavingsRates,
      dividendRates: TAX.dividendRates,

      savings: {
        startingRateLimit: TAX.srsLimit,
        personalSavingsAllowanceBasic: TAX.psa.basic,
        personalSavingsAllowanceHigher: TAX.psa.higher
      },

      dividendAllowance: TAX.dividendAllowance,

      ni: {
        primaryThreshold: TAX.ni.primaryThreshold,
        rate: TAX.ni.mainRate
      }
    };
  }

    

  // inputs  — plain object built by gatherInputs() in app.js
  // accounts — interest-bearing accounts array (may be empty)
  function runProjection(inputs, accounts) {
    const {
      startYear, endYear,
      p1DOB, p2DOB,
      p1name, p2name,
      spending, stepDownPct,
      p1Salary, p1SalaryStop,
      p2Salary, p2SalaryStop,
      p1SPAge, p1SPAmt,
      p2SPAge, p2SPAmt,
      growth, inflation,
      thresholdMode, thresholdFromYear,
      bniEnabled, bniP1GIA, bniP2GIA,
      dividendYield,
      withdrawalMode,
      p1Order, p2Order,
    } = inputs;

    // Deep-copy balances so the engine never mutates the caller's object
    const p1Bal = { ...inputs.p1Bal };
    const p2Bal = { ...inputs.p2Bal };

    if (!startYear || !endYear || endYear <= startYear) {
      alert('Please enter valid start and end years.');
      return null;
    }

    const ISA_ALLOWANCE = D.ISA_ALLOWANCE;

    const intAccts = (accounts || [])
      .filter(a => a.rate != null || a.monthlyDraw != null)
      .map(a => ({
        name:        a.name,
        owner:       a.owner,
        wrapper:     a.wrapper,
        balance:     a.value || 0,
        rate:        a.rate || 0,
        monthlyDraw: a.monthlyDraw || 0,
      }));

    let p1GIACost = p1Bal.GIA;
    let p2GIACost = p2Bal.GIA;

    const startBal = {
      [`${p1name} Cash`]: p1Bal.Cash, [`${p1name} GIA`]: p1Bal.GIA,
      [`${p1name} SIPP`]: p1Bal.SIPP, [`${p1name} ISA`]: p1Bal.ISA,
      [`${p2name} Cash`]: p2Bal.Cash, [`${p2name} GIA`]: p2Bal.GIA,
      [`${p2name} SIPP`]: p2Bal.SIPP, [`${p2name} ISA`]: p2Bal.ISA,
    };
    intAccts.forEach(a => {
      startBal[a.name + ' (' + a.owner + ')'] = a.balance || a.value || 0;
    });

    const depletions = {};
    let cumInfl = 1;
    const rows = [];

    for (let year = startYear; year <= endYear; year++) {
      const p1Age = year - p1DOB;
      const p2Age = year - p2DOB;
      const realDeflator = 1 / cumInfl;

      const p1SP     = p1Age >= p1SPAge ? p1SPAmt * cumInfl : 0;
      const p2SP     = p2Age >= p2SPAge ? p2SPAmt * cumInfl : 0;
      const p2SalInc = (p2SalaryStop && p2Age <= p2SalaryStop) ? p2Salary * cumInfl : 0;
      const p1SalInc = (p1SalaryStop && p1Age <= p1SalaryStop) ? p1Salary * cumInfl : 0;
      const target   = (spending * cumInfl) * (
        stepDownPct > 0 && p1Age >= 75 ? (1 - stepDownPct / 100) : 1
      );

      // Tax threshold uprating
      let uprateFactor = 1;
      if (thresholdMode === 'always') {
        uprateFactor = cumInfl;
      } else if (thresholdMode === 'fromYear' && year >= thresholdFromYear) {
        uprateFactor = cumInfl / Math.pow(1 + inflation, thresholdFromYear - startYear);
      }
      const baseRules     = C.getTaxRulesForYear(year);
      const effThresholds = C.upratedTaxRules(baseRules, uprateFactor);
      const effCGTExempt  = effThresholds.cgtExempt;

      // GIA dividends — opening balance × yield, paid out as cashflow (not reinvested).
      // Full amount is taxable when received regardless of spending need.
      // GIA balance is reduced by dividends before growth to avoid double-counting
      // (growth rate is total return; extracting dividends separately requires netting them out first).
      const p1GIAOpen  = p1Bal.GIA || 0;
      const p2GIAOpen  = p2Bal.GIA || 0;
      const p1Divs     = p1GIAOpen * dividendYield;
      const p2Divs     = p2GIAOpen * dividendYield;
      // All dividends are taxable as received — no spending-cap capping
      const p1DivsUsed = p1Divs;
      const p2DivsUsed = p2Divs;

      // Deduct dividends from GIA now (before growth) so growth applies to ex-dividend balance
      p1Bal.GIA = Math.max(0, (p1Bal.GIA || 0) - p1Divs);
      p2Bal.GIA = Math.max(0, (p2Bal.GIA || 0) - p2Divs);

      // FIX 1: annual CGT gain accumulators — reset each year, exemption applied once at year-end
      let p1AnnualGains = 0;
      let p2AnnualGains = 0;

      // Capture opening GIA balances and compute gain ratios ONCE (pre-growth, pre-B&I)
      const p1GIABalBefore = p1Bal.GIA || 0;
      const p2GIABalBefore = p2Bal.GIA || 0;
      const p1GainRatio = p1GIABalBefore > 0
        ? Math.max(0, p1GIABalBefore - p1GIACost) / p1GIABalBefore
        : 0;
      const p2GainRatio = p2GIABalBefore > 0
        ? Math.max(0, p2GIABalBefore - p2GIACost) / p2GIABalBefore
        : 0;

      // Bed-and-ISA: accumulate gains only, no exemption applied here
      if (bniEnabled) {
        if (bniP1GIA > 0 && p1Bal.GIA > 0) {
          const transfer  = Math.min(bniP1GIA, p1Bal.GIA, ISA_ALLOWANCE);
          p1AnnualGains  += transfer * p1GainRatio;
          const costFrac  = p1GIABalBefore > 0 ? transfer / p1GIABalBefore : 1;
          p1Bal.GIA      -= transfer;
          p1Bal.ISA      += transfer;
          p1GIACost       = Math.max(0, p1GIACost * (1 - costFrac));
        }
        if (bniP2GIA > 0 && p2Bal.GIA > 0) {
          const transfer  = Math.min(bniP2GIA, p2Bal.GIA, ISA_ALLOWANCE);
          p2AnnualGains  += transfer * p2GainRatio;
          const costFrac  = p2GIABalBefore > 0 ? transfer / p2GIABalBefore : 1;
          p2Bal.GIA      -= transfer;
          p2Bal.ISA      += transfer;
          p2GIACost       = Math.max(0, p2GIACost * (1 - costFrac));
        }
      }

      // Priority 1: interest-bearing accounts — capped to spending gap only
      let intDrawTotal = 0, p1IntDraw = 0, p2IntDraw = 0;
      let p1IntTaxable = 0, p2IntTaxable = 0;

      // How much of the target is already covered before interest draws
      const preIntGuaranteed = p1SP + p2SP + p1SalInc + p2SalInc + p1Divs + p2Divs;
      // Surplus salary/SP above target goes to p1 cash buffer
      const preIntSurplus    = Math.max(0, preIntGuaranteed - target);
      if (preIntSurplus > 0) p1Bal.Cash = (p1Bal.Cash || 0) + preIntSurplus;
      let intBudget = Math.max(0, target - preIntGuaranteed);

      intAccts.forEach(a => {
        if ((a.balance || 0) <= 0) return;

        const effectiveRate  = C.interestEffective(a.rate);
        const interestEarned = (a.balance || 0) * effectiveRate;
        const annualTarget   = (a.monthlyDraw || 0) * 12;
        const isP1           = a.owner === 'p1';

        if (annualTarget <= 0) {
          a.balance += interestEarned;
          if (a.wrapper !== 'ISA') {
            if (isP1) p1IntTaxable += interestEarned;
            else p2IntTaxable += interestEarned;
          }
          return;
        }

        // Cap draw to remaining spending budget
        const drawActual    = Math.min(annualTarget, intBudget, a.balance + interestEarned);
        const interestDrawn = Math.min(drawActual, interestEarned);

        a.balance -= Math.max(0, drawActual - interestDrawn);
        a.balance += interestEarned - interestDrawn;

        intDrawTotal += drawActual;
        intBudget    -= drawActual;
        if (isP1) p1IntDraw += drawActual;
        else p2IntDraw += drawActual;

        if (a.wrapper !== 'ISA') {
          if (isP1) p1IntTaxable += interestEarned;
          else p2IntTaxable += interestEarned;
        }

        const key = a.name + ' (' + a.owner + ')';
        if (!depletions[key] && (startBal[key] || 0) > 0 && a.balance <= 0) {
          depletions[key] = { year, age: year - (isP1 ? p1DOB : p2DOB) };
        }
      });

      // Priority 2: cash (dividends now count as guaranteed income)
      const guaranteed = p1SP + p2SP + p2SalInc + p1SalInc + intDrawTotal + p1Divs + p2Divs;
      let shortfall    = Math.max(0, target - guaranteed);

      let p1CashDrawn = 0;
      let p2CashDrawn = 0;

      if (shortfall > 0) {
        const totalCash = (p1Bal.Cash || 0) + (p2Bal.Cash || 0);
        const cashDrawn = Math.min(shortfall, totalCash);
        const fromP1    = Math.min(cashDrawn, p1Bal.Cash || 0);
        const fromP2    = Math.max(0, cashDrawn - fromP1);

        p1Bal.Cash -= fromP1;
        p2Bal.Cash = Math.max(0, (p2Bal.Cash || 0) - fromP2);

        p1CashDrawn = fromP1;
        p2CashDrawn = fromP2;
        shortfall  -= cashDrawn;
      }

        // Priority 3: wrapper draws
        const p1WrapperOrder = p1Order.filter(w => w !== 'Cash');
        const p2WrapperOrder = p2Order.filter(w => w !== 'Cash');
        
        let p1Drawn = { GIA: 0, SIPP: 0, ISA: 0, Cash: 0, sippTaxable: 0 };
        let p2Drawn = { GIA: 0, SIPP: 0, ISA: 0, Cash: 0, sippTaxable: 0 };
        
        let remainingShortfall = shortfall;
        
        // -----------------------------
        // MODE: 50 / 50 (pure mechanical)
        // -----------------------------
        if (withdrawalMode === '50/50') {
        
          const half = remainingShortfall / 2;
        
          // P1 draw
          let r1 = C.withdraw(p1Bal, p1WrapperOrder, half);
          p1Drawn.GIA += r1.GIA;
          p1Drawn.SIPP += r1.SIPP;
          p1Drawn.ISA += r1.ISA;
          p1Drawn.sippTaxable += r1.sippTaxable;
        
          const p1Total = r1.GIA + r1.SIPP + r1.ISA;
          let unmet = Math.max(0, half - p1Total);
        
          // P2 draw (takes its half + P1 unmet)
          let r2 = C.withdraw(p2Bal, p2WrapperOrder, half + unmet);
          p2Drawn.GIA += r2.GIA;
          p2Drawn.SIPP += r2.SIPP;
          p2Drawn.ISA += r2.ISA;
          p2Drawn.sippTaxable += r2.sippTaxable;
        
          const p2Total = r2.GIA + r2.SIPP + r2.ISA;
          let p2Unmet = Math.max(0, (half + unmet) - p2Total);
        
          // Final fallback to P1 only if needed
          if (p2Unmet > 0) {
            let r3 = C.withdraw(p1Bal, p1WrapperOrder, p2Unmet);
            p1Drawn.GIA += r3.GIA;
            p1Drawn.SIPP += r3.SIPP;
            p1Drawn.ISA += r3.ISA;
            p1Drawn.sippTaxable += r3.sippTaxable;
          }
        
        }
        
        // -----------------------------
        // MODE: TAX-AWARE
        // -----------------------------
        else {
        
          if (remainingShortfall > 0) {
        
            // -----------------------------
            // Step 1: fill Personal Allowance with SIPP
            // -----------------------------
            const p1BaseIncome = p1SP + p1SalInc + p1IntTaxable + p1Divs;
            const p2BaseIncome = p2SP + p2SalInc + p2IntTaxable + p2Divs;
        
            const p1PAHeadroom = Math.max(0, effThresholds.PA - p1BaseIncome);
            const p2PAHeadroom = Math.max(0, effThresholds.PA - p2BaseIncome);
        
            const p1TargetGross = Math.min(p1PAHeadroom / 0.75, p1Bal.SIPP || 0);
            const p2TargetGross = Math.min(p2PAHeadroom / 0.75, p2Bal.SIPP || 0);
        
            let r1 = C.withdraw(p1Bal, ['SIPP'], p1TargetGross);
            let r2 = C.withdraw(p2Bal, ['SIPP'], p2TargetGross);
        
            p1Drawn.SIPP += r1.SIPP;
            p1Drawn.sippTaxable += r1.sippTaxable;
        
            p2Drawn.SIPP += r2.SIPP;
            p2Drawn.sippTaxable += r2.sippTaxable;
        
            const sippDrawnTotal = r1.SIPP + r2.SIPP;
            remainingShortfall = Math.max(0, remainingShortfall - sippDrawnTotal);
        
            // -----------------------------
            // Step 2: non-SIPP wrappers (GIA / ISA)
            // -----------------------------
            if (remainingShortfall > 0) {
        
              const p1Non = p1WrapperOrder.filter(w => w !== 'SIPP');
              const p2Non = p2WrapperOrder.filter(w => w !== 'SIPP');
        
              const half = remainingShortfall / 2;
        
              let r1n = C.withdraw(p1Bal, p1Non, half);
              let r2n = C.withdraw(p2Bal, p2Non, half);
        
              p1Drawn.GIA += r1n.GIA;
              p1Drawn.ISA += r1n.ISA;
        
              p2Drawn.GIA += r2n.GIA;
              p2Drawn.ISA += r2n.ISA;
        
              const drawnNon =
                r1n.GIA + r1n.ISA +
                r2n.GIA + r2n.ISA;
        
              remainingShortfall = Math.max(0, remainingShortfall - drawnNon);
        
              // -----------------------------
              // Step 3: fallback (cross-draw)
              // -----------------------------
              if (remainingShortfall > 0) {
        
                let rFallback = C.withdraw(p1Bal, p1WrapperOrder, remainingShortfall);
        
                p1Drawn.GIA += rFallback.GIA;
                p1Drawn.ISA += rFallback.ISA;
                p1Drawn.SIPP += rFallback.SIPP;
                p1Drawn.sippTaxable += rFallback.sippTaxable;
        
                const fallbackTotal =
                  rFallback.GIA + rFallback.ISA + rFallback.SIPP;
        
                remainingShortfall = Math.max(0, remainingShortfall - fallbackTotal);
              }
        
              // -----------------------------
              // Step 4: final catch-all (SIPP only)
              // -----------------------------
              if (remainingShortfall > 0) {
        
                let rFinal = C.withdraw(p2Bal, ['SIPP'], remainingShortfall);
        
                p2Drawn.SIPP += rFinal.SIPP;
                p2Drawn.sippTaxable += rFinal.sippTaxable;
        
                const finalTotal = rFinal.SIPP;
        
                remainingShortfall = Math.max(0, remainingShortfall - finalTotal);
              }
            }
          }
        }

    // Add cash draws (always apply, never inside conditionals)
    p1Drawn.Cash += p1CashDrawn;
    p2Drawn.Cash += p2CashDrawn;
    
    // Growth
    C.growBalances(p1Bal, growth);
    C.growBalances(p2Bal, growth);
    
    // GIA gains
    p1AnnualGains += p1Drawn.GIA * p1GainRatio;
    p2AnnualGains += p2Drawn.GIA * p2GainRatio;
    
    // Update cost basis
    if (p1GIABalBefore > 0 && p1Drawn.GIA > 0) {
      p1GIACost *= (1 - Math.min(1, p1Drawn.GIA / p1GIABalBefore));
    }
    
    if (p2GIABalBefore > 0 && p2Drawn.GIA > 0) {
      p2GIACost *= (1 - Math.min(1, p2Drawn.GIA / p2GIABalBefore));
    }
    
    // Tax
    const rulesMapped = mapTaxRules(effThresholds);
    
    const p1TaxResult = calculateTax({
      salary: p1SalInc + p1SP + p1Drawn.sippTaxable,
      interest: p1IntTaxable,
      dividends: p1DivsUsed
    }, rulesMapped);
    
    const p2TaxResult = calculateTax({
      salary: p2SalInc + p2SP + p2Drawn.sippTaxable,
      interest: p2IntTaxable,
      dividends: p2DivsUsed
    }, rulesMapped);
      
    // CGT
    const p1TaxableGain = Math.max(0, p1AnnualGains - effCGTExempt);
    const p2TaxableGain = Math.max(0, p2AnnualGains - effCGTExempt);
    
    const p1TaxableIncome =
      (p1SalInc + p1SP + p1Drawn.sippTaxable + p1IntTaxable + p1DivsUsed)
      - effThresholds.PA;
    
    const p2TaxableIncome =
      (p2SalInc + p2SP + p2Drawn.sippTaxable + p2IntTaxable + p2DivsUsed)
      - effThresholds.PA;
    
    const p1CGT = C.calcCGT(Math.max(0, p1TaxableIncome), p1TaxableGain, effThresholds);
    const p2CGT = C.calcCGT(Math.max(0, p2TaxableIncome), p2TaxableGain, effThresholds);
    
    // NI
    const p1NI = p1TaxResult.ni;
    const p2NI = p2TaxResult.ni;
    
    // Income totals
    const p1IncomeTaxTotal =
      p1TaxResult.incomeTax +
      p1TaxResult.savingsTax +
      p1TaxResult.dividendTax;
    
    const p2IncomeTaxTotal =
      p2TaxResult.incomeTax +
      p2TaxResult.savingsTax +
      p2TaxResult.dividendTax;
    
    // Gross income
    const p1GrossIncome =
      p1SP + p1SalInc + p1IntDraw + p1DivsUsed +
      p1Drawn.Cash + p1Drawn.GIA + p1Drawn.SIPP + p1Drawn.ISA;
    
    const p2GrossIncome =
      p2SP + p2SalInc + p2IntDraw + p2DivsUsed +
      p2Drawn.Cash + p2Drawn.GIA + p2Drawn.SIPP + p2Drawn.ISA;
    
    // Totals
    const p1TaxTotal = p1TaxResult.total + p1CGT;
    const p2TaxTotal = p2TaxResult.total + p2CGT;
    
    const householdGrossIncome = p1GrossIncome + p2GrossIncome;
    const householdTax = p1TaxTotal + p2TaxTotal;
    const householdNetCashflow = householdGrossIncome - householdTax;
    
    // Natural income
    const p1NaturalIncome = p1SP + p1SalInc + p1IntDraw + p1Divs;
    const p2NaturalIncome = p2SP + p2SalInc + p2IntDraw + p2Divs;
    
    const p1NaturalNet = p1NaturalIncome - p1IncomeTaxTotal - p1NI;
    const p2NaturalNet = p2NaturalIncome - p2IncomeTaxTotal - p2NI;
    
    const householdNaturalNet = p1NaturalNet + p2NaturalNet;
        
    // Final push
    rows.push({
      year, p1Age, p2Age,
    
      target,
    
      p1SP, p2SP, p1SalInc, p2SalInc,
      intDrawTotal, p1IntDraw, p2IntDraw,
      p1IntTaxable, p2IntTaxable,
      p1Divs, p2Divs,
      p1DivsUsed, p2DivsUsed,
      p1Drawn, p2Drawn,
    
      p1IncomeTax: p1IncomeTaxTotal,
      p2IncomeTax: p2IncomeTaxTotal,
      p1CGT,
      p2CGT,
      p1NI,
      p2NI,
    
      p1Tax: p1TaxTotal,
      p2Tax: p2TaxTotal,
    
      p1GrossIncome,
      p2GrossIncome,
      householdGrossIncome,
      householdTax,
      householdNetCashflow,
    
      p1NaturalNet,
      p2NaturalNet,
      householdNaturalNet,
    
      p1TaxInc: p1SalInc + p1SP + p1Drawn.sippTaxable + p1IntTaxable + p1DivsUsed,
      p2TaxInc: p2SalInc + p2SP + p2Drawn.sippTaxable + p2IntTaxable + p2DivsUsed,
    
      p1AnnualGains,
      p2AnnualGains,
    
      // ✅ REQUIRED FOR RENDERER
      p1Cash: p1Bal.Cash || 0,
      p2Cash: p2Bal.Cash || 0,
    
      p1ISA: p1Bal.ISA || 0,
      p2ISA: p2Bal.ISA || 0,
    
      p1SIPP: p1Bal.SIPP || 0,
      p2SIPP: p2Bal.SIPP || 0,
    
      p1GIA: p1Bal.GIA || 0,
      p2GIA: p2Bal.GIA || 0,
    
      totalPortfolio:
        C.totalBal(p1Bal) +
        C.totalBal(p2Bal)
    });

      } // end for loop

      return {
        rows,
        depletions
      };
    }

    window.RetireEngine = {
      runProjection
    };

})();