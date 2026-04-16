(function () {
  const C = window.RetireCalc;
  const L = window.RetireLedger;

  // ─────────────────────────────────────────────────────────────────────────
  // withdrawalStrategy
  //
  // Decides HOW MUCH to draw from each wrapper for each person, given:
  //   - the remaining spending shortfall after guaranteed income (SP, salary,
  //     interest draws, dividends) and cash have already been applied
  //   - current balances (already mutated by cash draw — do not re-apply)
  //   - per-person allowance ledgers (mutated upstream by engine priority steps)
  //   - gain ratios and dividend yield for GIA tax-efficiency decisions
  //   - SIPP lock flags
  //
  // Returns { p1Drawn, p2Drawn } — each is:
  //   { GIA, SIPP, ISA, Cash, sippTaxable }
  //
  // The 'Cash' field in the return is always 0 here — cash draws are handled
  // upstream in engine.js (Priority 2) and merged back in after this call.
  //
  // Input shape:
  // {
  //   strategy,        — 'balanced' | 'isaFirst' | 'sippFirst'
  //   shortfall,       — remaining spend gap after guaranteed income and cash
  //   p1Bal, p2Bal,    — balances (already cash-reduced; mutated in place by C.withdraw)
  //   p1WrapperOrder,  — ['GIA','SIPP','ISA'] (Cash and locked SIPP already filtered)
  //   p2WrapperOrder,
  //   p1SIPPLocked,    — boolean
  //   p2SIPPLocked,
  //   p1Ledger,        — allowance ledger per person (from RetireLedger)
  //   p2Ledger,
  //   p1GainRatio,     — unrealised gain fraction of p1 GIA balance (0-1)
  //   p2GainRatio,     — unrealised gain fraction of p2 GIA balance (0-1)
  // }
  // ─────────────────────────────────────────────────────────────────────────

  const SIPP_TAXABLE_RATIO = C.SIPP_TAXABLE_RATIO; // 0.75

  function zero() {
    return { GIA: 0, SIPP: 0, ISA: 0, Cash: 0, sippTaxable: 0 };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  // Maximum SIPP gross draw that keeps taxable SIPP income within the basic-rate
  // band. Accounts for income already consumed by the ledger.
  function sippBasicRateCap(ledger, sippBal) {
    const paRoom   = ledger.paRemaining;
    const bandRoom = ledger.basicBandRemaining;
    const sippForPA   = paRoom   > 0 ? paRoom   / SIPP_TAXABLE_RATIO : 0;
    const sippForBand = bandRoom > 0 ? bandRoom / SIPP_TAXABLE_RATIO : 0;
    return Math.min(sippForPA + sippForBand, sippBal || 0);
  }

  // Maximum SIPP gross draw that fills only the Personal Allowance headroom.
  function sippPACap(ledger, sippBal) {
    const paRoom = ledger.paRemaining;
    if (paRoom <= 0) return 0;
    return Math.min(paRoom / SIPP_TAXABLE_RATIO, sippBal || 0);
  }

  // Draw from GIA or ISA depending on tax efficiency under the given strategy.
  // Tries GIA first if efficient; falls back to ISA otherwise.
  function drawGIAorISA(bal, amount, ledger, strategy, gainRatio) {
    if (amount <= 0) return zero();

    const giaAvail = bal.GIA || 0;
    const isaAvail = bal.ISA || 0;
    const drawn    = zero();

    if (L.giaIsEfficient(ledger, strategy, gainRatio, amount) && giaAvail > 0) {
      const fromGIA = Math.min(giaAvail, amount);
      drawn.GIA     = fromGIA;
      bal.GIA      -= fromGIA;
      const rem     = amount - fromGIA;
      if (rem > 0 && isaAvail > 0) {
        const fromISA = Math.min(isaAvail, rem);
        drawn.ISA     = fromISA;
        bal.ISA      -= fromISA;
      }
    } else {
      const fromISA = Math.min(isaAvail, amount);
      drawn.ISA     = fromISA;
      bal.ISA      -= fromISA;
      const rem     = amount - fromISA;
      if (rem > 0 && giaAvail > 0) {
        const fromGIA = Math.min(giaAvail, rem);
        drawn.GIA     = fromGIA;
        bal.GIA      -= fromGIA;
      }
    }

    return drawn;
  }

  // Merge a partial drawn object into an existing one in-place.
  function mergeDraw(target, source) {
    target.GIA         += source.GIA         || 0;
    target.SIPP        += source.SIPP        || 0;
    target.ISA         += source.ISA         || 0;
    target.sippTaxable += source.sippTaxable || 0;
  }

  // Total non-cash drawn from a drawn object.
  function drawnTotal(d) {
    return (d.GIA || 0) + (d.SIPP || 0) + (d.ISA || 0);
  }

  // ── Fallback ──────────────────────────────────────────────────────────────
  // Shifts unmet demand from one person to the other, then does a final SIPP
  // catch-all if shortfall still remains. Shared across all strategies.

  function applyFallback(
    shortfall, p1Drawn, p2Drawn,
    p1Bal, p2Bal,
    p1WrapperOrder, p2WrapperOrder,
    p1SIPPLocked, p2SIPPLocked,
    p1Target, p2Target,
  ) {
    // Step A: shift unmet demand cross-person
    const p1Unmet = Math.max(0, p1Target - drawnTotal(p1Drawn));
    const p2Unmet = Math.max(0, p2Target - drawnTotal(p2Drawn));

    if (p1Unmet > 0) {
      const extra = C.withdraw(p2Bal, p2WrapperOrder, p1Unmet);
      mergeDraw(p2Drawn, extra);
    }
    if (p2Unmet > 0) {
      const extra = C.withdraw(p1Bal, p1WrapperOrder, p2Unmet);
      mergeDraw(p1Drawn, extra);
    }

    // Step B: final SIPP catch-all if shortfall still unmet
    const totalDrawn = drawnTotal(p1Drawn) + drawnTotal(p2Drawn);
    const stillUnmet = Math.max(0, shortfall - totalDrawn);

    if (stillUnmet > 0) {
      const p1Extra = !p1SIPPLocked
        ? C.withdraw(p1Bal, ['SIPP'], stillUnmet / 2)
        : { SIPP: 0, sippTaxable: 0 };
      const p2Share = stillUnmet / 2 + Math.max(0, stillUnmet / 2 - (p1Extra.SIPP || 0));
      const p2Extra = !p2SIPPLocked
        ? C.withdraw(p2Bal, ['SIPP'], p2Share)
        : { SIPP: 0, sippTaxable: 0 };

      mergeDraw(p1Drawn, p1Extra);
      mergeDraw(p2Drawn, p2Extra);

      const p2StillUnmet = Math.max(0, stillUnmet / 2 - (p2Extra.SIPP || 0));
      if (p2StillUnmet > 0 && !p1SIPPLocked) {
        const p1Last = C.withdraw(p1Bal, ['SIPP'], p2StillUnmet);
        mergeDraw(p1Drawn, p1Last);
      }
    }
  }

  // ── Strategy: balanced ────────────────────────────────────────────────────
  // Draw SIPP up to basic-rate band ceiling for each person.
  // Remaining shortfall split proportionally by remaining basic-band headroom.
  // GIA vs ISA decided dynamically via ledger tax-efficiency check.

  function strategyBalanced({
    shortfall, p1Bal, p2Bal,
    p1WrapperOrder, p2WrapperOrder,
    p1SIPPLocked, p2SIPPLocked,
    p1Ledger, p2Ledger,
    p1GainRatio, p2GainRatio,
  }) {
    if (shortfall <= 0) return { p1Drawn: zero(), p2Drawn: zero() };

    // Step 1: SIPP to fill PA + basic band
    const p1SippTarget = !p1SIPPLocked ? sippBasicRateCap(p1Ledger, p1Bal.SIPP) : 0;
    const p2SippTarget = !p2SIPPLocked ? sippBasicRateCap(p2Ledger, p2Bal.SIPP) : 0;

    const p1Drawn = C.withdraw(p1Bal, ['SIPP'], p1SippTarget);
    const p2Drawn = C.withdraw(p2Bal, ['SIPP'], p2SippTarget);

    L.consumeNonSavings(p1Ledger, p1Drawn.sippTaxable);
    L.consumeNonSavings(p2Ledger, p2Drawn.sippTaxable);

    const sippDrawTotal = (p1Drawn.SIPP || 0) + (p2Drawn.SIPP || 0);
    const remShortfall  = Math.max(0, shortfall - sippDrawTotal);

    // Step 2: split remaining by basic-band headroom
    const p1BandRoom    = p1Ledger.basicBandRemaining;
    const p2BandRoom    = p2Ledger.basicBandRemaining;
    const totalBandRoom = p1BandRoom + p2BandRoom;
    const p1Weight      = totalBandRoom > 0 ? p1BandRoom / totalBandRoom : 0.5;

    const p1Target = remShortfall * p1Weight;
    const p2Target = remShortfall * (1 - p1Weight);

    // Step 3: GIA or ISA based on tax efficiency
    const p1RemDrawn = drawGIAorISA(p1Bal, p1Target, p1Ledger, 'balanced', p1GainRatio);
    const p2RemDrawn = drawGIAorISA(p2Bal, p2Target, p2Ledger, 'balanced', p2GainRatio);

    mergeDraw(p1Drawn, p1RemDrawn);
    mergeDraw(p2Drawn, p2RemDrawn);

    // Step 4: fallback for unmet demand
    applyFallback(
      shortfall, p1Drawn, p2Drawn,
      p1Bal, p2Bal,
      p1WrapperOrder, p2WrapperOrder,
      p1SIPPLocked, p2SIPPLocked,
      p1Target, p2Target,
    );

    return { p1Drawn, p2Drawn };
  }

  // ── Strategy: isaFirst ────────────────────────────────────────────────────
  // Preserve pension as long as possible.
  // Draw SIPP only to fill PA. Prefer ISA; use GIA only at 0% marginal rate.
  // Remaining shortfall split proportionally by PA headroom.

  function strategyISAFirst({
    shortfall, p1Bal, p2Bal,
    p1WrapperOrder, p2WrapperOrder,
    p1SIPPLocked, p2SIPPLocked,
    p1Ledger, p2Ledger,
    p1GainRatio, p2GainRatio,
  }) {
    if (shortfall <= 0) return { p1Drawn: zero(), p2Drawn: zero() };

    // Step 1: SIPP to fill PA only
    const p1SippTarget = !p1SIPPLocked ? sippPACap(p1Ledger, p1Bal.SIPP) : 0;
    const p2SippTarget = !p2SIPPLocked ? sippPACap(p2Ledger, p2Bal.SIPP) : 0;

    const p1Drawn = C.withdraw(p1Bal, ['SIPP'], p1SippTarget);
    const p2Drawn = C.withdraw(p2Bal, ['SIPP'], p2SippTarget);

    L.consumeNonSavings(p1Ledger, p1Drawn.sippTaxable);
    L.consumeNonSavings(p2Ledger, p2Drawn.sippTaxable);

    const sippDrawTotal = (p1Drawn.SIPP || 0) + (p2Drawn.SIPP || 0);
    const remShortfall  = Math.max(0, shortfall - sippDrawTotal);

    // Step 2: split remaining by PA headroom
    const p1PARoom    = p1Ledger.paRemaining;
    const p2PARoom    = p2Ledger.paRemaining;
    const totalPARoom = p1PARoom + p2PARoom;
    const p1Weight    = totalPARoom > 0 ? p1PARoom / totalPARoom : 0.5;

    const p1Target = remShortfall * p1Weight;
    const p2Target = remShortfall * (1 - p1Weight);

    // Step 3: ISA-first draw
    const p1RemDrawn = drawGIAorISA(p1Bal, p1Target, p1Ledger, 'isaFirst', p1GainRatio);
    const p2RemDrawn = drawGIAorISA(p2Bal, p2Target, p2Ledger, 'isaFirst', p2GainRatio);

    mergeDraw(p1Drawn, p1RemDrawn);
    mergeDraw(p2Drawn, p2RemDrawn);

    // Step 4: fallback
    applyFallback(
      shortfall, p1Drawn, p2Drawn,
      p1Bal, p2Bal,
      p1WrapperOrder, p2WrapperOrder,
      p1SIPPLocked, p2SIPPLocked,
      p1Target, p2Target,
    );

    return { p1Drawn, p2Drawn };
  }

  // ── Strategy: sippFirst ───────────────────────────────────────────────────
  // Accelerate pension depletion — maximise SIPP draw within basic-rate band.
  // GIA drawn freely within basic rate; ISA used only approaching higher rate.
  // Remaining shortfall split proportionally by basic-band headroom.

  function strategySIPPFirst({
    shortfall, p1Bal, p2Bal,
    p1WrapperOrder, p2WrapperOrder,
    p1SIPPLocked, p2SIPPLocked,
    p1Ledger, p2Ledger,
    p1GainRatio, p2GainRatio,
  }) {
    if (shortfall <= 0) return { p1Drawn: zero(), p2Drawn: zero() };

    // Step 1: SIPP to full basic-rate band ceiling (aggressive)
    const p1SippTarget = !p1SIPPLocked ? sippBasicRateCap(p1Ledger, p1Bal.SIPP) : 0;
    const p2SippTarget = !p2SIPPLocked ? sippBasicRateCap(p2Ledger, p2Bal.SIPP) : 0;

    const p1Drawn = C.withdraw(p1Bal, ['SIPP'], p1SippTarget);
    const p2Drawn = C.withdraw(p2Bal, ['SIPP'], p2SippTarget);

    L.consumeNonSavings(p1Ledger, p1Drawn.sippTaxable);
    L.consumeNonSavings(p2Ledger, p2Drawn.sippTaxable);

    const sippDrawTotal = (p1Drawn.SIPP || 0) + (p2Drawn.SIPP || 0);
    const remShortfall  = Math.max(0, shortfall - sippDrawTotal);

    // Step 2: split remaining by basic-band headroom
    const p1BandRoom    = p1Ledger.basicBandRemaining;
    const p2BandRoom    = p2Ledger.basicBandRemaining;
    const totalBandRoom = p1BandRoom + p2BandRoom;
    const p1Weight      = totalBandRoom > 0 ? p1BandRoom / totalBandRoom : 0.5;

    const p1Target = remShortfall * p1Weight;
    const p2Target = remShortfall * (1 - p1Weight);

    // Step 3: GIA-permissive draw
    const p1RemDrawn = drawGIAorISA(p1Bal, p1Target, p1Ledger, 'sippFirst', p1GainRatio);
    const p2RemDrawn = drawGIAorISA(p2Bal, p2Target, p2Ledger, 'sippFirst', p2GainRatio);

    mergeDraw(p1Drawn, p1RemDrawn);
    mergeDraw(p2Drawn, p2RemDrawn);

    // Step 4: fallback
    applyFallback(
      shortfall, p1Drawn, p2Drawn,
      p1Bal, p2Bal,
      p1WrapperOrder, p2WrapperOrder,
      p1SIPPLocked, p2SIPPLocked,
      p1Target, p2Target,
    );

    return { p1Drawn, p2Drawn };
  }

  // ── Main entry point ──────────────────────────────────────────────────────

  function withdrawalStrategy(params) {
    switch (params.strategy) {
      case 'isaFirst':  return strategyISAFirst(params);
      case 'sippFirst': return strategySIPPFirst(params);
      case 'balanced':
      default:          return strategyBalanced(params);
    }
  }

  window.RetireWithdrawalStrategy = { withdrawalStrategy };
})();
