(function () {
  const C = window.RetireCalc;
  const L = window.RetireLedger;

  // ─────────────────────────────────────────────────────────────────────────
  // withdrawalStrategy
  //
  // Strategy intents:
  //   balanced  — draw SIPP up to min(basicRateCap, shortfall); GIA/ISA fill
  //               remainder dynamically. Paces pension draw to spending need.
  //   isaFirst  — preserve pension; draw ISA unconditionally first, GIA fallback,
  //               SIPP only to fill any remaining PA headroom.
  //   sippFirst — aggressively deplete pension; draw SIPP to full basic-rate
  //               ceiling even if it exceeds spending need, recycling surplus
  //               into ISA. GIA fills any residual gap.
  // ─────────────────────────────────────────────────────────────────────────

  const SIPP_TAXABLE_RATIO = C.SIPP_TAXABLE_RATIO; // 0.75

  function zero() {
    return { GIA: 0, SIPP: 0, ISA: 0, Cash: 0, sippTaxable: 0 };
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  function sippBasicRateCap(ledger, sippBal) {
    const paRoom      = ledger.paRemaining;
    const bandRoom    = ledger.basicBandRemaining;
    const sippForPA   = paRoom   > 0 ? paRoom   / SIPP_TAXABLE_RATIO : 0;
    const sippForBand = bandRoom > 0 ? bandRoom / SIPP_TAXABLE_RATIO : 0;
    return Math.min(sippForPA + sippForBand, sippBal || 0);
  }

  function sippPACap(ledger, sippBal) {
    const paRoom = ledger.paRemaining;
    if (paRoom <= 0) return 0;
    return Math.min(paRoom / SIPP_TAXABLE_RATIO, sippBal || 0);
  }

  // Given a net spending target, return the gross SIPP draw needed so that
  // gross minus income tax equals targetNet. Accounts for remaining PA headroom
  // and basic-rate band. Does NOT exceed the basic-rate ceiling or sippBal.
  //
  // Two-zone model:
  //   Zone 1 — draw within PA headroom: tax = 0, gross = net (1:1)
  //   Zone 2 — draw into basic-rate band: net = gross * (1 - TAXABLE * rate)
  //
  // The caller is responsible for any further cap against strategy-specific limits.
  function sippGrossUp(targetNet, ledger, sippBal) {
    if (targetNet <= 0) return 0;
    const paRoom   = Math.max(0, ledger.paRemaining);
    const bandRoom = Math.max(0, ledger.basicBandRemaining);
    const RATE     = 0.20;

    // Gross SIPP that exhausts remaining PA headroom (tax-free portion)
    const sippToFillPA = paRoom / SIPP_TAXABLE_RATIO;

    let grossNeeded;
    if (targetNet <= sippToFillPA) {
      // Entire draw sits within PA — no tax, no gross-up needed
      grossNeeded = targetNet;
    } else {
      // PA portion is tax-free; remaining net requires grossing up at basic rate
      const netFromPA = sippToFillPA;
      const remNet    = targetNet - netFromPA;
      const grossRem  = remNet / (1 - SIPP_TAXABLE_RATIO * RATE);
      // Cap grossRem at the basic-rate band — strategy must not over-draw into higher rate
      const maxBandGross = bandRoom / SIPP_TAXABLE_RATIO;
      grossNeeded = sippToFillPA + Math.min(grossRem, maxBandGross);
    }

    return Math.min(grossNeeded, sippBal || 0);
  }

  function mergeDraw(target, source) {
    target.GIA         += source.GIA         || 0;
    target.SIPP        += source.SIPP        || 0;
    target.ISA         += source.ISA         || 0;
    target.sippTaxable += source.sippTaxable || 0;
  }

  function drawnTotal(d) {
    return (d.GIA || 0) + (d.SIPP || 0) + (d.ISA || 0);
  }

  // ISA-first draw: unconditionally prefers ISA, falls back to GIA.
  // No tax-efficiency check — ISA is always the first choice.
  function drawISAorGIA(bal, amount) {
    if (amount <= 0) return zero();
    const drawn   = zero();
    const fromISA = Math.min(bal.ISA || 0, amount);
    drawn.ISA = fromISA;
    bal.ISA  -= fromISA;
    const rem = amount - fromISA;
    if (rem > 0 && (bal.GIA || 0) > 0) {
      const fromGIA = Math.min(bal.GIA, rem);
      drawn.GIA = fromGIA;
      bal.GIA  -= fromGIA;
    }
    return drawn;
  }

  // GIA-first draw: prefers GIA within basic/0% CGT, falls back to ISA.
  // Used by balanced and sippFirst.
  function drawGIAorISA(bal, amount, ledger, gainRatio) {
    if (amount <= 0) return zero();
    const drawn        = zero();
    const rate         = L.marginalGIARate(ledger, gainRatio);
    const giaEfficient = rate < ledger._TAX.cgtRates.higher;

    if (giaEfficient && (bal.GIA || 0) > 0) {
      const fromGIA = Math.min(bal.GIA, amount);
      drawn.GIA = fromGIA;
      bal.GIA  -= fromGIA;
      const rem = amount - fromGIA;
      if (rem > 0 && (bal.ISA || 0) > 0) {
        const fromISA = Math.min(bal.ISA, rem);
        drawn.ISA = fromISA;
        bal.ISA  -= fromISA;
      }
    } else {
      const fromISA = Math.min(bal.ISA || 0, amount);
      drawn.ISA = fromISA;
      bal.ISA  -= fromISA;
      const rem = amount - fromISA;
      if (rem > 0 && (bal.GIA || 0) > 0) {
        const fromGIA = Math.min(bal.GIA, rem);
        drawn.GIA = fromGIA;
        bal.GIA  -= fromGIA;
      }
    }
    return drawn;
  }

  // ── Fallback ──────────────────────────────────────────────────────────────

  function applyFallback(
    shortfall, p1Drawn, p2Drawn,
    p1Bal, p2Bal,
    p1WrapperOrder, p2WrapperOrder,
    p1SIPPLocked, p2SIPPLocked,
    p1Target, p2Target,
    p1Ledger, p2Ledger,   // optional — used for SIPP gross-up in last-resort sweep
    p1SippNetIn, p2SippNetIn, // optional — net already delivered by SIPP (pre-computed by caller)
  ) {
    // Net delivered so far per person. ISA/GIA are tax-free (gross=net).
    // SIPP net is passed in by caller when pre-computed; otherwise use gross as proxy.
    const p1NonSipp0 = (p1Drawn.GIA || 0) + (p1Drawn.ISA || 0);
    const p2NonSipp0 = (p2Drawn.GIA || 0) + (p2Drawn.ISA || 0);
    const p1NetSoFar = (p1SippNetIn !== undefined ? p1SippNetIn : (p1Drawn.SIPP || 0)) + p1NonSipp0;
    const p2NetSoFar = (p2SippNetIn !== undefined ? p2SippNetIn : (p2Drawn.SIPP || 0)) + p2NonSipp0;

    // Cross-compensation: p1Target/p2Target are net figures. Compare against net delivered.
    const p1Unmet = Math.max(0, p1Target - p1NetSoFar);
    const p2Unmet = Math.max(0, p2Target - p2NetSoFar);

    // Snapshot SIPP gross before cross-compensation to compute net of any new SIPP draws.
    const p1SippBefore = p1Drawn.SIPP || 0;
    const p2SippBefore = p2Drawn.SIPP || 0;
    const p1PABefore0  = p1Ledger ? p1Ledger.paRemaining : 0;
    const p2PABefore0  = p2Ledger ? p2Ledger.paRemaining : 0;

    if (p1Unmet > 0) mergeDraw(p2Drawn, C.withdraw(p2Bal, p2WrapperOrder, p1Unmet));
    if (p2Unmet > 0) mergeDraw(p1Drawn, C.withdraw(p1Bal, p1WrapperOrder, p2Unmet));

    // Net of any SIPP added during cross-compensation (wrapperOrder may hit SIPP).
    const p1SippAdded    = (p1Drawn.SIPP || 0) - p1SippBefore;
    const p2SippAdded    = (p2Drawn.SIPP || 0) - p2SippBefore;
    const p1SippAddedNet = p1SippAdded - Math.max(0, p1SippAdded * 0.75 - p1PABefore0) * 0.20;
    const p2SippAddedNet = p2SippAdded - Math.max(0, p2SippAdded * 0.75 - p2PABefore0) * 0.20;

    // stillUnmet: total net after cross-compensation.
    const p1NonSipp1 = (p1Drawn.GIA || 0) + (p1Drawn.ISA || 0);
    const p2NonSipp1 = (p2Drawn.GIA || 0) + (p2Drawn.ISA || 0);
    const p1NetAfter = (p1SippNetIn !== undefined ? p1SippNetIn : p1SippBefore) + p1SippAddedNet + p1NonSipp1;
    const p2NetAfter = (p2SippNetIn !== undefined ? p2SippNetIn : p2SippBefore) + p2SippAddedNet + p2NonSipp1;
    const stillUnmet = Math.max(0, shortfall - p1NetAfter - p2NetAfter);
    if (stillUnmet > 0) {
      const half = stillUnmet / 2;

      // p1 draw — gross up, withdraw, consume ledger, compute net delivered.
      const p1PABefore = p1Ledger ? p1Ledger.paRemaining : 0;
      const p1SippGross = p1Ledger ? sippGrossUp(half, p1Ledger, p1Bal.SIPP) : half;
      const p1Extra     = !p1SIPPLocked ? C.withdraw(p1Bal, ['SIPP'], p1SippGross) : { SIPP: 0, sippTaxable: 0 };
      if (p1Ledger && (p1Extra.sippTaxable || 0) > 0) L.consumeNonSavings(p1Ledger, p1Extra.sippTaxable);
      mergeDraw(p1Drawn, p1Extra);
      const p1ExtraTax = Math.max(0, (p1Extra.sippTaxable || 0) - p1PABefore) * 0.20;
      const p1ExtraNet = (p1Extra.SIPP || 0) - p1ExtraTax;

      // p2 draw — gross up for remaining net gap using updated p2 ledger.
      const p2Rem = half + Math.max(0, half - p1ExtraNet);
      const p2PABefore = p2Ledger ? p2Ledger.paRemaining : 0;
      const p2SippGross = p2Ledger ? sippGrossUp(p2Rem, p2Ledger, p2Bal.SIPP) : p2Rem;
      const p2Extra     = !p2SIPPLocked ? C.withdraw(p2Bal, ['SIPP'], p2SippGross) : { SIPP: 0, sippTaxable: 0 };
      if (p2Ledger && (p2Extra.sippTaxable || 0) > 0) L.consumeNonSavings(p2Ledger, p2Extra.sippTaxable);
      mergeDraw(p2Drawn, p2Extra);
      const p2ExtraTax = Math.max(0, (p2Extra.sippTaxable || 0) - p2PABefore) * 0.20;
      const p2ExtraNet = (p2Extra.SIPP || 0) - p2ExtraTax;

      // p1 mop-up: cover any net gap p2 couldn't fill.
      const p2Still = Math.max(0, p2Rem - p2ExtraNet);
      if (p2Still > 0 && !p1SIPPLocked) {
        const p1PABefore2   = p1Ledger ? p1Ledger.paRemaining : 0;
        const p1StillGross  = p1Ledger ? sippGrossUp(p2Still, p1Ledger, p1Bal.SIPP) : p2Still;
        const p1StillExtra  = C.withdraw(p1Bal, ['SIPP'], p1StillGross);
        if (p1Ledger && (p1StillExtra.sippTaxable || 0) > 0) L.consumeNonSavings(p1Ledger, p1StillExtra.sippTaxable);
        mergeDraw(p1Drawn, p1StillExtra);
      }
    }
  }

  // ── Strategy: balanced ────────────────────────────────────────────────────

  function strategyBalanced({
    shortfall, p1Bal, p2Bal,
    p1WrapperOrder, p2WrapperOrder,
    p1SIPPLocked, p2SIPPLocked,
    p1Ledger, p2Ledger,
    p1GainRatio, p2GainRatio,
  }) {
    if (shortfall <= 0) return { p1Drawn: zero(), p2Drawn: zero() };

    // SIPP grossed up to deliver half the shortfall net of tax, capped at the
    // basic-rate ceiling. Grossing up ensures the draw accounts for income tax
    // so that the net received matches the intended contribution to the target.
    const half         = shortfall / 2;
    const p1SippTarget = !p1SIPPLocked ? Math.min(sippGrossUp(half, p1Ledger, p1Bal.SIPP), sippBasicRateCap(p1Ledger, p1Bal.SIPP)) : 0;
    const p2SippTarget = !p2SIPPLocked ? Math.min(sippGrossUp(half, p2Ledger, p2Bal.SIPP), sippBasicRateCap(p2Ledger, p2Bal.SIPP)) : 0;

    const p1Drawn = C.withdraw(p1Bal, ['SIPP'], p1SippTarget);
    const p2Drawn = C.withdraw(p2Bal, ['SIPP'], p2SippTarget);

    // Compute net delivered by SIPP draws (gross minus tax on taxable portion).
    // remShortfall must be a net figure so that p1Target/p2Target are comparable
    // to ISA/GIA draws (which are tax-free, so gross = net for those wrappers).
    const p1SippTax = Math.max(0, (p1Drawn.sippTaxable || 0) - p1Ledger.paRemaining) * 0.20;
    const p2SippTax = Math.max(0, (p2Drawn.sippTaxable || 0) - p2Ledger.paRemaining) * 0.20;
    const p1SippNet = (p1Drawn.SIPP || 0) - p1SippTax;
    const p2SippNet = (p2Drawn.SIPP || 0) - p2SippTax;

    L.consumeNonSavings(p1Ledger, p1Drawn.sippTaxable);
    L.consumeNonSavings(p2Ledger, p2Drawn.sippTaxable);

    const remShortfall  = Math.max(0, shortfall - p1SippNet - p2SippNet);
    // Weight by liquid assets so each person's target reflects what they can contribute.
    const p1LiquidB = (p1Bal.SIPP || 0) + (p1Bal.ISA || 0) + (p1Bal.GIAeq || p1Bal.GIA || 0);
    const p2LiquidB = (p2Bal.SIPP || 0) + (p2Bal.ISA || 0) + (p2Bal.GIAeq || p2Bal.GIA || 0);
    const totLiquidB = p1LiquidB + p2LiquidB;
    const p1Weight   = totLiquidB > 0 ? p1LiquidB / totLiquidB : 0.5;
    const p1Target   = remShortfall * p1Weight;
    const p2Target   = remShortfall * (1 - p1Weight);

    mergeDraw(p1Drawn, drawGIAorISA(p1Bal, p1Target, p1Ledger, p1GainRatio));
    mergeDraw(p2Drawn, drawGIAorISA(p2Bal, p2Target, p2Ledger, p2GainRatio));

    applyFallback(
      shortfall, p1Drawn, p2Drawn, p1Bal, p2Bal,
      p1WrapperOrder, p2WrapperOrder, p1SIPPLocked, p2SIPPLocked,
      p1Target, p2Target,
      p1Ledger, p2Ledger,
      p1SippNet, p2SippNet,
    );

    return { p1Drawn, p2Drawn };
  }

  // ── Strategy: isaFirst ────────────────────────────────────────────────────

  function strategyISAFirst({
    shortfall, p1Bal, p2Bal,
    p1WrapperOrder, p2WrapperOrder,
    p1SIPPLocked, p2SIPPLocked,
    p1Ledger, p2Ledger,
    p1GainRatio, p2GainRatio,
  }) {
    if (shortfall <= 0) return { p1Drawn: zero(), p2Drawn: zero() };

    // SIPP only to fill remaining PA headroom, grossed up so the net received
    // equals the PA headroom contribution, capped at half the shortfall.
    const half         = shortfall / 2;
    const p1SippTarget = !p1SIPPLocked ? Math.min(sippGrossUp(Math.min(half, p1Ledger.paRemaining), p1Ledger, p1Bal.SIPP), sippPACap(p1Ledger, p1Bal.SIPP)) : 0;
    const p2SippTarget = !p2SIPPLocked ? Math.min(sippGrossUp(Math.min(half, p2Ledger.paRemaining), p2Ledger, p2Bal.SIPP), sippPACap(p2Ledger, p2Bal.SIPP)) : 0;

    const p1Drawn = C.withdraw(p1Bal, ['SIPP'], p1SippTarget);
    const p2Drawn = C.withdraw(p2Bal, ['SIPP'], p2SippTarget);

    // Net delivered by SIPP (gross minus tax on taxable portion above PA).
    const p1SippTax = Math.max(0, (p1Drawn.sippTaxable || 0) - p1Ledger.paRemaining) * 0.20;
    const p2SippTax = Math.max(0, (p2Drawn.sippTaxable || 0) - p2Ledger.paRemaining) * 0.20;
    const p1SippNet = (p1Drawn.SIPP || 0) - p1SippTax;
    const p2SippNet = (p2Drawn.SIPP || 0) - p2SippTax;

    L.consumeNonSavings(p1Ledger, p1Drawn.sippTaxable);
    L.consumeNonSavings(p2Ledger, p2Drawn.sippTaxable);

    const remShortfall = Math.max(0, shortfall - p1SippNet - p2SippNet);

    // Split by ISA balance; fall back to GIA, then SIPP, then 50/50 if all empty.
    // Including SIPP in the fallback ensures one person with only SIPP gets weight=1
    // rather than 0.5, avoiding spurious cross-compensation draws.
    const p1ISA = p1Bal.ISA || 0;
    const p2ISA = p2Bal.ISA || 0;
    const p1GIA = p1Bal.GIA || 0;
    const p2GIA = p2Bal.GIA || 0;
    const totalISA = p1ISA + p2ISA;
    const totalGIA = p1GIA + p2GIA;
    const p1SIPPBal = p1Bal.SIPP || 0;
    const p2SIPPBal = p2Bal.SIPP || 0;
    const totalSIPP = p1SIPPBal + p2SIPPBal;
    const p1Liquid = totalISA > 0 ? p1ISA : (totalGIA > 0 ? p1GIA : (totalSIPP > 0 ? p1SIPPBal : 1));
    const total    = totalISA > 0 ? totalISA : (totalGIA > 0 ? totalGIA : (totalSIPP > 0 ? totalSIPP : 2));
    const p1Weight = p1Liquid / total;

    const p1Target = remShortfall * p1Weight;
    const p2Target = remShortfall * (1 - p1Weight);

    // Unconditionally ISA-first — no tax-efficiency gate
    mergeDraw(p1Drawn, drawISAorGIA(p1Bal, p1Target));
    mergeDraw(p2Drawn, drawISAorGIA(p2Bal, p2Target));

    applyFallback(
      shortfall, p1Drawn, p2Drawn, p1Bal, p2Bal,
      p1WrapperOrder, p2WrapperOrder, p1SIPPLocked, p2SIPPLocked,
      p1Target, p2Target,
      p1Ledger, p2Ledger,
      p1SippNet, p2SippNet,
    );

    return { p1Drawn, p2Drawn };
  }

  // ── Strategy: sippFirst ───────────────────────────────────────────────────

  function strategySIPPFirst({
    shortfall, p1Bal, p2Bal,
    p1WrapperOrder, p2WrapperOrder,
    p1SIPPLocked, p2SIPPLocked,
    p1Ledger, p2Ledger,
    p1GainRatio, p2GainRatio,
  }) {
    if (shortfall <= 0) return { p1Drawn: zero(), p2Drawn: zero() };

    // SIPP to full basic-rate ceiling — NOT capped by shortfall.
    // Any surplus above spending need is recycled into ISA (net of 20% tax).
    const p1SippTarget = !p1SIPPLocked ? sippBasicRateCap(p1Ledger, p1Bal.SIPP) : 0;
    const p2SippTarget = !p2SIPPLocked ? sippBasicRateCap(p2Ledger, p2Bal.SIPP) : 0;

    // Capture pre-draw PA headroom so we can compute tax on the full gross draw.
    const p1PABefore = p1Ledger.paRemaining;
    const p2PABefore = p2Ledger.paRemaining;

    const p1Drawn = C.withdraw(p1Bal, ['SIPP'], p1SippTarget);
    const p2Drawn = C.withdraw(p2Bal, ['SIPP'], p2SippTarget);
    L.consumeNonSavings(p1Ledger, p1Drawn.sippTaxable);
    L.consumeNonSavings(p2Ledger, p2Drawn.sippTaxable);

    const sippTotal = (p1Drawn.SIPP || 0) + (p2Drawn.SIPP || 0);

    // Compute net delivered by the full draw (gross minus income tax).
    const p1FullTax  = Math.max(0, (p1Drawn.sippTaxable || 0) - p1PABefore) * 0.20;
    const p2FullTax  = Math.max(0, (p2Drawn.sippTaxable || 0) - p2PABefore) * 0.20;
    const sippNetTotal = sippTotal - p1FullTax - p2FullTax;
    const surplus    = sippNetTotal - shortfall;

    if (surplus > 0) {
      // Recycle surplus (net) into ISA — net of 20% tax on the 75% taxable portion.
      const netFactor  = 1 - (SIPP_TAXABLE_RATIO * 0.20);
      const p1SurpFrac = sippTotal > 0 ? (p1Drawn.SIPP || 0) / sippTotal : 0.5;
      p1Bal.ISA = (p1Bal.ISA || 0) + surplus * p1SurpFrac       * netFactor;
      p2Bal.ISA = (p2Bal.ISA || 0) + surplus * (1 - p1SurpFrac) * netFactor;

      // Replace the full gross draws with gross-up draws that net to shortfall.
      // Scaling by shortfall/sippNetTotal is wrong because PA creates non-linearity
      // (tax is not proportional to gross when PA headroom is partially consumed).
      // Instead, restore the ledger to pre-draw state and use sippGrossUp to find
      // the correct gross per person that nets to their share of shortfall.
      //
      // Restore ledger PA: consumeNonSavings already ran, so add taxable back.
      p1Ledger.paRemaining       = Math.min(p1PABefore, p1Ledger.paRemaining + (p1Drawn.sippTaxable || 0));
      p2Ledger.paRemaining       = Math.min(p2PABefore, p2Ledger.paRemaining + (p2Drawn.sippTaxable || 0));
      p1Ledger.basicBandRemaining = Math.min(p1Ledger._basicBandAtStart, p1Ledger.basicBandRemaining + Math.max(0, (p1Drawn.sippTaxable || 0) - p1PABefore));
      p2Ledger.basicBandRemaining = Math.min(p2Ledger._basicBandAtStart, p2Ledger.basicBandRemaining + Math.max(0, (p2Drawn.sippTaxable || 0) - p2PABefore));

      // Split shortfall by each person's share of the original gross draw.
      const p1Share = sippTotal > 0 ? ((p1Drawn.SIPP || 0) / sippTotal) * shortfall : shortfall / 2;
      const p2Share = shortfall - p1Share;

      // Gross up each person's share so net = their share.
      const p1GrossNeeded = sippGrossUp(p1Share, p1Ledger, p1Bal.SIPP + (p1Drawn.SIPP || 0));
      const p2GrossNeeded = sippGrossUp(p2Share, p2Ledger, p2Bal.SIPP + (p2Drawn.SIPP || 0));

      // Re-consume ledger with the correct draws.
      const p1Taxable = p1GrossNeeded * SIPP_TAXABLE_RATIO;
      const p2Taxable = p2GrossNeeded * SIPP_TAXABLE_RATIO;
      L.consumeNonSavings(p1Ledger, p1Taxable);
      L.consumeNonSavings(p2Ledger, p2Taxable);

      p1Drawn.SIPP        = p1GrossNeeded;
      p2Drawn.SIPP        = p2GrossNeeded;
      p1Drawn.sippTaxable = p1Taxable;
      p2Drawn.sippTaxable = p2Taxable;

      return { p1Drawn, p2Drawn };
    }

    // SIPP draw fell short — fill remainder from GIA then ISA.
    // Compute net delivered by SIPP so remShortfall is a net figure.
    const p1SippTax2 = Math.max(0, (p1Drawn.sippTaxable || 0) - p1Ledger.paRemaining) * 0.20;
    const p2SippTax2 = Math.max(0, (p2Drawn.sippTaxable || 0) - p2Ledger.paRemaining) * 0.20;
    const p1SippNet2 = (p1Drawn.SIPP || 0) - p1SippTax2;
    const p2SippNet2 = (p2Drawn.SIPP || 0) - p2SippTax2;
    const remShortfall  = Math.max(0, shortfall - p1SippNet2 - p2SippNet2);
    const p1BandRoom    = p1Ledger.basicBandRemaining;
    const p2BandRoom    = p2Ledger.basicBandRemaining;
    const totalBandRoom = p1BandRoom + p2BandRoom;
    const p1Weight      = totalBandRoom > 0 ? p1BandRoom / totalBandRoom : 0.5;
    const p1Target      = remShortfall * p1Weight;
    const p2Target      = remShortfall * (1 - p1Weight);

    mergeDraw(p1Drawn, drawGIAorISA(p1Bal, p1Target, p1Ledger, p1GainRatio));
    mergeDraw(p2Drawn, drawGIAorISA(p2Bal, p2Target, p2Ledger, p2GainRatio));

    applyFallback(
      shortfall, p1Drawn, p2Drawn, p1Bal, p2Bal,
      p1WrapperOrder, p2WrapperOrder, p1SIPPLocked, p2SIPPLocked,
      p1Target, p2Target,
      p1Ledger, p2Ledger,
      p1SippNet2, p2SippNet2,
    );

    return { p1Drawn, p2Drawn };
  }

  // ── Strategy: taxMin ──────────────────────────────────────────────────────
  //
  // Draws from whichever wrapper produces the lowest marginal tax on each
  // pound, consulting the ledger in real time. Steps in priority order:
  //
  //   1. SIPP to remaining PA headroom          — 0% effective (25% TFLS covers)
  //   2. GIA/Cash interest to SRS + PSA          — already consumed by engine;
  //                                                nothing discretionary here
  //   3. GIA capital to remaining CGT allowance  — 0% CGT
  //   4. ISA for remaining shortfall             — always 0% (exact need only)
  //   5. Taxable SIPP into basic-rate band       — 20% income tax
  //   6. GIA at basic-rate CGT                   — 18% CGT
  //   7. Fallback                                — applyFallback (higher-rate)
  //
  // Two-person split: proportional by each person's headroom for that step.
  // Scotland is a known gap — band rates scoped to England only.

  function strategyTaxMin({
    shortfall, p1Bal, p2Bal,
    p1WrapperOrder, p2WrapperOrder,
    p1SIPPLocked, p2SIPPLocked,
    p1Ledger, p2Ledger,
    p1GainRatio, p2GainRatio,
  }) {
    if (shortfall <= 0) return { p1Drawn: zero(), p2Drawn: zero() };

    const p1Drawn = zero();
    const p2Drawn = zero();
    let rem = shortfall;   // running remaining shortfall (net)
    let p1SippNetAccum = 0; // net delivered by SIPP draws for p1
    let p2SippNetAccum = 0; // net delivered by SIPP draws for p2

    // ── Step 1: SIPP to PA headroom (tax-free effective rate) ──────────────
    {
      const p1Cap = !p1SIPPLocked ? sippPACap(p1Ledger, p1Bal.SIPP) : 0;
      const p2Cap = !p2SIPPLocked ? sippPACap(p2Ledger, p2Bal.SIPP) : 0;
      const total = p1Cap + p2Cap;
      const draw  = Math.min(total, rem);

      if (draw > 0 && total > 0) {
        const p1Share = draw * (p1Cap / total);
        const p2Share = draw * (p2Cap / total);

        const d1 = C.withdraw(p1Bal, ['SIPP'], p1Share);
        const d2 = C.withdraw(p2Bal, ['SIPP'], p2Share);
        L.consumeNonSavings(p1Ledger, d1.sippTaxable);
        L.consumeNonSavings(p2Ledger, d2.sippTaxable);
        mergeDraw(p1Drawn, d1);
        mergeDraw(p2Drawn, d2);
        // Step 1 draws within PA headroom — tax-free so net = gross.
        p1SippNetAccum += d1.SIPP || 0;
        p2SippNetAccum += d2.SIPP || 0;
        rem -= (d1.SIPP || 0) + (d2.SIPP || 0);
      }
    }

    // ── Step 2: GIA/Cash interest within SRS + PSA ────────────────────────
    // Interest accrual is non-discretionary — already consumed by the engine
    // before withdrawalStrategy runs. The ledger's srsRemaining / psaRemaining
    // already reflect any interest. Nothing to draw here.

    // ── Step 3: GIA capital within CGT allowance (0% CGT) ─────────────────
    if (rem > 0) {
      const p1Exempt = p1Ledger.cgtAllowRemaining;
      const p2Exempt = p2Ledger.cgtAllowRemaining;
      const totalEx  = p1Exempt + p2Exempt;

      if (totalEx > 0) {
        const p1MaxGIA = p1GainRatio > 0
          ? Math.min(p1Exempt / p1GainRatio, p1Bal.GIA || 0)
          : (p1Bal.GIA || 0);
        const p2MaxGIA = p2GainRatio > 0
          ? Math.min(p2Exempt / p2GainRatio, p2Bal.GIA || 0)
          : (p2Bal.GIA || 0);

        const available = p1MaxGIA + p2MaxGIA;
        const draw      = Math.min(available, rem);

        if (draw > 0 && available > 0) {
          const p1Share = draw * (p1MaxGIA / available);
          const p2Share = draw * (p2MaxGIA / available);

          const p1GIADraw = Math.min(p1Share, p1Bal.GIA || 0);
          const p2GIADraw = Math.min(p2Share, p2Bal.GIA || 0);

          p1Bal.GIA -= p1GIADraw;
          p2Bal.GIA -= p2GIADraw;
          p1Drawn.GIA += p1GIADraw;
          p2Drawn.GIA += p2GIADraw;

          L.consumeGains(p1Ledger, p1GIADraw * p1GainRatio);
          L.consumeGains(p2Ledger, p2GIADraw * p2GainRatio);

          rem -= p1GIADraw + p2GIADraw;
        }
      }
    }

    // ── Step 4: ISA for remaining shortfall (exact, no surplus) ───────────
    if (rem > 0) {
      const p1ISA = p1Bal.ISA || 0;
      const p2ISA = p2Bal.ISA || 0;
      const totalISA = p1ISA + p2ISA;
      const draw     = Math.min(totalISA, rem);

      if (draw > 0 && totalISA > 0) {
        const p1Share = draw * (p1ISA / totalISA);
        const p2Share = draw * (p2ISA / totalISA);

        const d1 = C.withdraw(p1Bal, ['ISA'], p1Share);
        const d2 = C.withdraw(p2Bal, ['ISA'], p2Share);
        mergeDraw(p1Drawn, d1);
        mergeDraw(p2Drawn, d2);
        rem -= (d1.ISA || 0) + (d2.ISA || 0);
      }
    }

    // ── Step 5: Taxable SIPP into basic-rate band only (20% IT) ───────────
    // rem is a net target; gross up so the draw net of tax equals rem.
    if (rem > 0) {
      const p1GrossTarget = !p1SIPPLocked ? sippGrossUp(rem / 2, p1Ledger, p1Bal.SIPP) : 0;
      const p2GrossTarget = !p2SIPPLocked ? sippGrossUp(rem / 2, p2Ledger, p2Bal.SIPP) : 0;
      const p1Cap = !p1SIPPLocked ? Math.min(p1GrossTarget, sippBasicRateCap(p1Ledger, p1Bal.SIPP)) : 0;
      const p2Cap = !p2SIPPLocked ? Math.min(p2GrossTarget, sippBasicRateCap(p2Ledger, p2Bal.SIPP)) : 0;

      // Allocate by each person's gross cap, not band room — band room is the same
      // for both persons when both are basic-rate, so using it as a weight causes
      // p2's unclaimed share to be wasted when p2 has no SIPP.
      const totalCap = p1Cap + p2Cap;
      if (totalCap > 0) {
        const p1PABefore5 = p1Ledger.paRemaining;
        const p2PABefore5 = p2Ledger.paRemaining;

        const d1 = !p1SIPPLocked ? C.withdraw(p1Bal, ['SIPP'], p1Cap) : zero();
        const d2 = !p2SIPPLocked ? C.withdraw(p2Bal, ['SIPP'], p2Cap) : zero();
        L.consumeNonSavings(p1Ledger, d1.sippTaxable);
        L.consumeNonSavings(p2Ledger, d2.sippTaxable);
        mergeDraw(p1Drawn, d1);
        mergeDraw(p2Drawn, d2);

        // Reduce rem by net delivered (gross minus tax), not gross.
        const p1Tax5 = Math.max(0, (d1.sippTaxable || 0) - p1PABefore5) * 0.20;
        const p2Tax5 = Math.max(0, (d2.sippTaxable || 0) - p2PABefore5) * 0.20;
        const p1Net5 = (d1.SIPP || 0) - p1Tax5;
        const p2Net5 = (d2.SIPP || 0) - p2Tax5;
        p1SippNetAccum += p1Net5;
        p2SippNetAccum += p2Net5;
        rem -= p1Net5 + p2Net5;
      }
    }

    // ── Step 6: GIA at basic-rate CGT (18%) ───────────────────────────────
    // Guard: skip entirely if both persons have exhausted their basic-rate band.
    // Drawing GIA when basicBandRemaining === 0 would incur 24% CGT (higher
    // rate), contradicting this step's intent. Step 7 handles any residual.
    if (rem > 0) {
      const p1Band = p1Ledger.basicBandRemaining;
      const p2Band = p2Ledger.basicBandRemaining;
      const totalBand = p1Band + p2Band;

      const p1GIA = p1Bal.GIA || 0;
      const p2GIA = p2Bal.GIA || 0;
      const totalGIA = p1GIA + p2GIA;
      const draw     = Math.min(totalGIA, rem);

      if (draw > 0 && totalGIA > 0 && totalBand > 0) {
        const p1Weight = p1Band / totalBand;
        const p2Weight = p2Band / totalBand;
        const p1Share  = Math.min(draw * p1Weight, p1GIA);
        const p2Share  = Math.min(draw * p2Weight, p2GIA);

        p1Bal.GIA -= p1Share;
        p2Bal.GIA -= p2Share;
        p1Drawn.GIA += p1Share;
        p2Drawn.GIA += p2Share;

        L.consumeGains(p1Ledger, p1Share * p1GainRatio);
        L.consumeGains(p2Ledger, p2Share * p2GainRatio);

        rem -= p1Share + p2Share;
      }
    }

    // ── Step 7: Fallback (higher-rate band / whatever remains) ────────────
    if (rem > 0) {
      const p1Target = rem / 2;
      const p2Target = rem / 2;
      applyFallback(
        shortfall, p1Drawn, p2Drawn, p1Bal, p2Bal,
        p1WrapperOrder, p2WrapperOrder, p1SIPPLocked, p2SIPPLocked,
        p1Target, p2Target,
        p1Ledger, p2Ledger,
        p1SippNetAccum, p2SippNetAccum,
      );
    }

    return { p1Drawn, p2Drawn };
  }

  // ── Main entry point ──────────────────────────────────────────────────────

  function withdrawalStrategy(params) {
    switch (params.strategy) {
      case 'isaFirst':  return strategyISAFirst(params);
      case 'sippFirst': return strategySIPPFirst(params);
      case 'taxMin':    return strategyTaxMin(params);
      case 'balanced':
      default:          return strategyBalanced(params);
    }
  }

  window.RetireWithdrawalStrategy = { withdrawalStrategy };
})();
