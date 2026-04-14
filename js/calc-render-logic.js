/**
 * calc-render-logic.js
 *
 * Pure data-transform functions that map engine rows[] → chart dataset arrays,
 * table row objects, and metric aggregates.
 *
 * No DOM access. No Chart.js. No side effects.
 * All functions are stateless — every relevant parameter is passed explicitly.
 *
 * calc-render.js calls these functions and handles all DOM/Chart.js concerns.
 * This file is also the entry point for render unit tests.
 */
(function () {
  const D = window.RetireData;

  // ─────────────────────────────────────────────
  // CORE SCALAR
  // ─────────────────────────────────────────────

  /**
   * Apply real/nominal adjustment to a value.
   * @param {number} val      - Nominal value from engine row
   * @param {object} row      - Engine row (must have .realDeflator)
   * @param {boolean} useReal - true → multiply by realDeflator
   * @returns {number}
   */
  function adj(val, row, useReal) {
    return useReal ? val * row.realDeflator : val;
  }

  // ─────────────────────────────────────────────
  // INCOME CHART
  // ─────────────────────────────────────────────

  /**
   * Build the income chart datasets array.
   * One dataset per income source. Values in £k (divided by 1000).
   * Each dataset carries _lifetimeValue (£, not £k) for the legend.
   *
   * @param {object[]} rows
   * @param {'p1'|'p2'|'both'} viewPerson
   * @param {boolean} useReal
   * @returns {object[]} Chart.js dataset array
   */
  function buildIncomeDatasets(rows, viewPerson, useReal, p1name, p2name) {
    const COLOURS = {
      salary:   '#FF7F7F',
      p1Cash:   '#B0B0B0',
      intDraw:  '#9B59B6',
      p1Divs:   '#27AE60',
      p1GIA:    '#A9D18E',
      p1ISA:    '#5B9BD5',
      p1SIPP:   '#ED7D31',
      p1SP:     '#4472C4',
      shortfall:'#DC2626',
    };

    // When viewing a single person, prefix each source label with their name.
    // When viewing both, use the generic source name (combined draw).
    const pfx = viewPerson === 'p1' ? (p1name || 'Person 1') + "'s "
              : viewPerson === 'p2' ? (p2name || 'Person 2') + "'s "
              : '';

    function ds(label, p1fn, p2fn, color) {
      const bothFn = r => (p1fn(r) || 0) + (p2fn(r) || 0);
      const fn = viewPerson === 'p1' ? p1fn
               : viewPerson === 'p2' ? p2fn
               : bothFn;
      return {
        label: pfx + label,
        data: rows.map(r => adj(fn(r) || 0, r, useReal) / 1000),
        backgroundColor: color,
        stack: 'income',
        _lifetimeValue: rows.reduce((s, r) => s + adj(fn(r) || 0, r, useReal), 0),
      };
    }

    const targetData = rows.map(r => adj(r.target || 0, r, useReal) / 1000);

    const engineShortfall = buildEngineShortfall(rows, viewPerson, useReal, targetData);

    const sets = [];
    sets.push(ds('State Pension', r => r.p1SP               ?? 0, r => r.p2SP               ?? 0, COLOURS.p1SP));
    sets.push(ds('Salary',        r => r.p1SalInc           ?? 0, r => r.p2SalInc           ?? 0, COLOURS.salary));
    sets.push(ds('Cash',          r => r.p1Drawn?.Cash      ?? 0, r => r.p2Drawn?.Cash      ?? 0, COLOURS.p1Cash));
    sets.push(ds('Interest',      r => r.p1IntDraw          ?? 0, r => r.p2IntDraw          ?? 0, COLOURS.intDraw));
    sets.push(ds('Dividends',     r => r.p1DivsUsed         ?? 0, r => r.p2DivsUsed         ?? 0, COLOURS.p1Divs));
    sets.push(ds('GIA',           r => r.p1Drawn?.GIA       ?? 0, r => r.p2Drawn?.GIA       ?? 0, COLOURS.p1GIA));
    sets.push(ds('ISA',           r => r.p1Drawn?.ISA       ?? 0, r => r.p2Drawn?.ISA       ?? 0, COLOURS.p1ISA));
    sets.push(ds('SIPP / WP',     r => r.p1Drawn?.SIPP      ?? 0, r => r.p2Drawn?.SIPP      ?? 0, COLOURS.p1SIPP));

    // Cap each row's stacked total at the spending target.
    // When guaranteed income (salary + SP) exceeds target in a given year,
    // the engine parks the surplus in Cash — the chart must not show more than
    // the target. Walk datasets in chart order, consuming the budget per row.
    const nSources = sets.length; // Shortfall not yet added
    for (let i = 0; i < rows.length; i++) {
      let remaining = targetData[i]; // adj'd £k
      for (let s = 0; s < nSources; s++) {
        const val = sets[s].data[i] || 0;
        if (remaining <= 0) {
          sets[s].data[i] = 0;
        } else if (val > remaining) {
          sets[s].data[i] = remaining;
          remaining = 0;
        } else {
          remaining -= val;
        }
      }
    }
    // Recompute _lifetimeValue after capping so legend totals match chart
    for (let s = 0; s < nSources; s++) {
      sets[s]._lifetimeValue = sets[s].data.reduce((sum, v) => sum + (v || 0) * 1000, 0);
    }

    sets.push({
      label: 'Shortfall',
      data: engineShortfall.slice(),
      backgroundColor: COLOURS.shortfall,
      stack: 'income',
    });

    return sets;
  }

  /**
   * Build the engine shortfall array — the gap between visible person gross
   * income and the full household spending target.
   *
   * @param {object[]} rows
   * @param {'p1'|'p2'|'both'} viewPerson
   * @param {boolean} useReal
   * @param {number[]} targetData - already adj'd £k values, one per row
   * @returns {number[]} shortfall in £k, ≥ 0
   */
  function buildEngineShortfall(rows, viewPerson, useReal, targetData) {
    return rows.map((r, i) => {
      const p1Gross = (r.p1SP               ?? 0) + (r.p1SalInc          ?? 0) +
                      (r.p1Drawn?.SIPP     ?? 0) + (r.p1Drawn?.ISA       ?? 0) +
                      (r.p1Drawn?.GIA      ?? 0) + (r.p1IntDraw          ?? 0) +
                      (r.p1DivsUsed        ?? 0) + (r.p1Drawn?.Cash      ?? 0);
      const p2Gross = (r.p2SP               ?? 0) + (r.p2SalInc          ?? 0) +
                      (r.p2Drawn?.SIPP     ?? 0) + (r.p2Drawn?.ISA       ?? 0) +
                      (r.p2Drawn?.GIA      ?? 0) + (r.p2IntDraw          ?? 0) +
                      (r.p2DivsUsed        ?? 0) + (r.p2Drawn?.Cash      ?? 0);
      const visibleGross = viewPerson === 'p1' ? p1Gross
                         : viewPerson === 'p2' ? p2Gross
                         : p1Gross + p2Gross;
      return adj(Math.max(0, (r.target || 0) - visibleGross), r, useReal) / 1000;
    });
  }

  // ─────────────────────────────────────────────
  // GROSS VS NET CHART
  // ─────────────────────────────────────────────

  /**
   * Per-row gross income for the selected view.
   * @param {object} r
   * @param {'p1'|'p2'|'both'} viewPerson
   * @returns {number}
   */
  function grossFn(r, viewPerson) {
    return viewPerson === 'p1' ? (r.p1GrossIncome  || 0)
         : viewPerson === 'p2' ? (r.p2GrossIncome  || 0)
         : (r.householdGrossIncome || 0);
  }

  /**
   * Per-row total tax (income tax + CGT + NI) for the selected view.
   * @param {object} r
   * @param {'p1'|'p2'|'both'} viewPerson
   * @returns {number}
   */
  function taxFn(r, viewPerson) {
    return viewPerson === 'p1'
      ? (r.p1IncomeTax ?? 0) + (r.p1CGT ?? 0) + (r.p1NI ?? 0)
      : viewPerson === 'p2'
        ? (r.p2IncomeTax ?? 0) + (r.p2CGT ?? 0) + (r.p2NI ?? 0)
        : (r.p1IncomeTax ?? 0) + (r.p1CGT ?? 0) + (r.p1NI ?? 0) +
          (r.p2IncomeTax ?? 0) + (r.p2CGT ?? 0) + (r.p2NI ?? 0);
  }

  /**
   * Build the Gross vs Net chart datasets: [netDataset, taxDataset].
   * Bar total = gross. Values in £k.
   *
   * @param {object[]} rows
   * @param {'p1'|'p2'|'both'} viewPerson
   * @param {boolean} useReal
   * @returns {object[]} [netDs, taxDs]
   */
  function buildGrossNetDatasets(rows, viewPerson, useReal) {
    // Cap gross at the spending target: surplus years park the overflow in Cash
    // (engine lines 176-183) -- the chart should not display more than the target.
    // Tax is left uncapped -- it is a real liability regardless of the surplus.
    const cappedGross = r => Math.min(grossFn(r, viewPerson), r.target ?? 0);

    const netDs = {
      label: 'Net income',
      data: rows.map(r => adj(cappedGross(r) - taxFn(r, viewPerson), r, useReal) / 1000),
      backgroundColor: '#4472C4',
      stack: 'gross',
      type: 'bar',
      _lifetimeValue: rows.reduce((s, r) =>
        s + adj(cappedGross(r) - taxFn(r, viewPerson), r, useReal), 0),
    };

    const taxDs = {
      label: 'Tax',
      data: rows.map(r => adj(taxFn(r, viewPerson), r, useReal) / 1000),
      backgroundColor: '#C55A11',
      stack: 'gross',
      type: 'bar',
      _lifetimeValue: rows.reduce((s, r) => s + adj(taxFn(r, viewPerson), r, useReal), 0),
      _fixed: true,
    };

    return [netDs, taxDs];
  }

  // ─────────────────────────────────────────────
  // TAX CHART
  // ─────────────────────────────────────────────

  /**
   * Build the tax bar data (£, not £k) and rate line data (%) for the tax chart.
   *
   * @param {object[]} rows
   * @param {'p1'|'p2'|'both'} viewPerson
   * @param {boolean} useReal
   * @returns {{ taxData: number[], rateData: number[] }}
   */
  function buildTaxChartData(rows, viewPerson, useReal) {
    const taxData = rows.map(r => {
      const t = taxFn(r, viewPerson);
      return Math.round(adj(t, r, useReal));
    });

    const rateData = rows.map(r => {
      const tax   = taxFn(r, viewPerson);
      const gross = grossFn(r, viewPerson);
      return gross > 0 ? parseFloat((tax / gross * 100).toFixed(1)) : 0;
    });

    return { taxData, rateData };
  }

  // ─────────────────────────────────────────────
  // WEALTH CHART
  // ─────────────────────────────────────────────

  /**
   * Build the wealth chart datasets array.
   * Values in £ (not £k — note: live chart uses £, not £k like income chart).
   * Order is fixed: p1 [Cash, Interest, GIA, SIPP, ISA], p2 [Cash, Interest, GIA, SIPP, ISA].
   * The viewPerson filter is applied by slicing: p1=slice(0,5), p2=slice(5), both=all.
   *
   * @param {object[]} rows
   * @param {'p1'|'p2'|'both'} viewPerson
   * @param {boolean} useReal
   * @param {string} p1name - display name for person 1
   * @param {string} p2name - display name for person 2
   * @returns {object[]} Chart.js dataset array (already filtered for viewPerson)
   */
  function buildWealthDatasets(rows, viewPerson, useReal, p1name, p2name) {
    const p1 = p1name || 'Person 1';
    const p2 = p2name || 'Person 2';

    // Fixed order — slice indices (0,5) and (5) depend on this order being stable
    const allDatasets = [
      // ── p1 block: indices 0–4 ──
      {
        label: `${p1}'s Cash`,
        data: rows.map(r => Math.round(adj(r.snap?.p1Cash    ?? 0, r, useReal))),
        backgroundColor: '#B0B0B0',
        stack: 'wealth',
        _snapField: 'p1Cash',
      },
      {
        label: `${p1}'s Interest`,
        data: rows.map(r => Math.round(adj(r.snap?.p1IntBal  ?? 0, r, useReal))),
        backgroundColor: '#9B59B6',
        stack: 'wealth',
        _snapField: 'p1IntBal',
      },
      {
        label: `${p1}'s GIA`,
        data: rows.map(r => Math.round(adj(r.snap?.p1GIA     ?? 0, r, useReal))),
        backgroundColor: '#A9D18E',
        stack: 'wealth',
        _snapField: 'p1GIA',
      },
      {
        label: `${p1}'s SIPP / WP`,
        data: rows.map(r => Math.round(adj(r.snap?.p1SIPP    ?? 0, r, useReal))),
        backgroundColor: '#ED7D31',
        stack: 'wealth',
        _snapField: 'p1SIPP',
      },
      {
        label: `${p1}'s ISA`,
        data: rows.map(r => Math.round(adj(r.snap?.p1ISA     ?? 0, r, useReal))),
        backgroundColor: '#5B9BD5',
        stack: 'wealth',
        _snapField: 'p1ISA',
      },
      // ── p2 block: indices 5–9 ──
      {
        label: `${p2}'s Cash`,
        data: rows.map(r => Math.round(adj(r.snap?.p2Cash    ?? 0, r, useReal))),
        backgroundColor: '#D0D0D0',
        stack: 'wealth',
        _snapField: 'p2Cash',
      },
      {
        label: `${p2}'s Interest`,
        data: rows.map(r => Math.round(adj(r.snap?.p2IntBal  ?? 0, r, useReal))),
        backgroundColor: '#C39BD3',
        stack: 'wealth',
        _snapField: 'p2IntBal',
      },
      {
        label: `${p2}'s GIA`,
        data: rows.map(r => Math.round(adj(r.snap?.p2GIA     ?? 0, r, useReal))),
        backgroundColor: '#78C86A',
        stack: 'wealth',
        _snapField: 'p2GIA',
      },
      {
        label: `${p2}'s SIPP / WP`,
        data: rows.map(r => Math.round(adj(r.snap?.p2SIPP    ?? 0, r, useReal))),
        backgroundColor: '#FFC000',
        stack: 'wealth',
        _snapField: 'p2SIPP',
      },
      {
        label: `${p2}'s ISA`,
        data: rows.map(r => Math.round(adj(r.snap?.p2ISA     ?? 0, r, useReal))),
        backgroundColor: '#2E86C1',
        stack: 'wealth',
        _snapField: 'p2ISA',
      },
    ];

    return viewPerson === 'p1' ? allDatasets.slice(0, 5)
         : viewPerson === 'p2' ? allDatasets.slice(5)
         : allDatasets;
  }

  // ─────────────────────────────────────────────
  // TABLE ROWS
  // ─────────────────────────────────────────────

  /**
   * Build per-row objects for the tax table.
   * All values are adj'd to real or nominal as requested.
   *
   * @param {object[]} rows
   * @param {boolean} useReal
   * @returns {object[]} Array of { year, p1Age, p2Age, wi, wc, wn, wt, hi, hc, hn, ht, hh, cumTax }
   */
  function buildTableTaxRows(rows, useReal) {
    const a = (val, row) => useReal ? val * row.realDeflator : val;
    let cumTax = 0;
    return rows.map(r => {
      const wi = a(r.p1IncomeTax ?? 0, r);
      const wc = a(r.p1CGT       ?? 0, r);
      const wn = a(r.p1NI        ?? 0, r);
      const hi = a(r.p2IncomeTax ?? 0, r);
      const hc = a(r.p2CGT       ?? 0, r);
      const hn = a(r.p2NI        ?? 0, r);
      const wt = wi + wc + wn;
      const ht = hi + hc + hn;
      const hh = wt + ht;
      cumTax += hh;
      return { year: r.year, p1Age: r.p1Age, p2Age: r.p2Age,
               wi, wc, wn, wt, hi, hc, hn, ht, hh, cumTax };
    });
  }

  /**
   * Build per-row objects for the wealth table.
   * All snap values are adj'd; the total is the sum of all 10 snap fields.
   *
   * @param {object[]} rows
   * @param {boolean} useReal
   * @returns {object[]} Array of { year, p1Age, p2Age, p1Cash, p1IntBal, p1GIA, p1SIPP, p1ISA,
   *                                                      p2Cash, p2IntBal, p2GIA, p2SIPP, p2ISA, total }
   */
  function buildTableWealthRows(rows, useReal) {
    const a = (val, row) => useReal ? val * row.realDeflator : val;
    return rows.map(r => {
      const s      = r.snap ?? {};
      const p1Cash   = a(s.p1Cash   ?? 0, r);
      const p1IntBal = a(s.p1IntBal || 0, r);
      const p1GIA    = a(s.p1GIA    || 0, r);
      const p1SIPP   = a(s.p1SIPP   || 0, r);
      const p1ISA    = a(s.p1ISA    || 0, r);
      const p2Cash   = a(s.p2Cash   || 0, r);
      const p2IntBal = a(s.p2IntBal || 0, r);
      const p2GIA    = a(s.p2GIA    || 0, r);
      const p2SIPP   = a(s.p2SIPP   || 0, r);
      const p2ISA    = a(s.p2ISA    || 0, r);
      const total = p1Cash + p1IntBal + p1GIA + p1SIPP + p1ISA
                  + p2Cash + p2IntBal + p2GIA + p2SIPP + p2ISA;
      return { year: r.year, p1Age: r.p1Age, p2Age: r.p2Age,
               p1Cash, p1IntBal, p1GIA, p1SIPP, p1ISA,
               p2Cash, p2IntBal, p2GIA, p2SIPP, p2ISA, total };
    });
  }

  // ─────────────────────────────────────────────
  // METRICS (STAT CARDS)
  // ─────────────────────────────────────────────

  /**
   * Build the values shown in the always-visible stat cards.
   *
   * @param {object[]} rows
   * @param {'p1'|'p2'|'both'} viewPerson
   * @param {boolean} useReal
   * @returns {{ totalTax: number, lifetimeGross: number, avgRate: number, lastPortfolio: number }}
   */
  function buildMetrics(rows, viewPerson, useReal) {
    if (!rows.length) return { totalTax: 0, lifetimeGross: 0, avgRate: 0, lastPortfolio: 0 };

    const { lifetimeTax, lifetimeGross } = rows.reduce((s, r) => {
      const tax   = viewPerson === 'p1'
        ? (r.p1IncomeTax ?? 0) + (r.p1CGT ?? 0) + (r.p1NI ?? 0)
        : viewPerson === 'p2'
          ? (r.p2IncomeTax ?? 0) + (r.p2CGT ?? 0) + (r.p2NI ?? 0)
          : (r.p1IncomeTax ?? 0) + (r.p1CGT ?? 0) + (r.p1NI ?? 0) +
            (r.p2IncomeTax ?? 0) + (r.p2CGT ?? 0) + (r.p2NI ?? 0);
      const gross = grossFn(r, viewPerson);
      return {
        lifetimeTax:   s.lifetimeTax   + adj(tax,   r, useReal),
        lifetimeGross: s.lifetimeGross + adj(gross,  r, useReal),
      };
    }, { lifetimeTax: 0, lifetimeGross: 0 });

    const avgRate     = lifetimeGross > 0 ? lifetimeTax / lifetimeGross : 0;
    const last        = rows[rows.length - 1];
    const lastPortfolio = adj(last.totalPortfolio, last, useReal);

    return { totalTax: lifetimeTax, lifetimeGross, avgRate, lastPortfolio };
  }

  // ─────────────────────────────────────────────
  // SCHEMA VALIDATION
  // ─────────────────────────────────────────────

  /**
   * Validate a single engine row has the expected shape.
   * Throws immediately with a descriptive message if any required field is absent.
   * Call once over the full rows array before rendering:
   *   _rows.forEach(L.validateRow);
   *
   * @param {object} r - Engine row
   * @throws {Error} if any required field is missing
   */
  function validateRow(r) {
    if (!r || !r.year)
      throw new Error(`validateRow: row missing 'year' — got ${JSON.stringify(r)}`);

    // Drawn objects must exist and contain every sub-field the renderer touches.
    // Check !== undefined (not truthiness) — zero is a valid value for all of these.
    const DRAWN_FIELDS = ['Cash', 'GIA', 'ISA', 'SIPP', 'sippTaxable'];
    for (const person of ['p1Drawn', 'p2Drawn']) {
      if (!r[person] || typeof r[person] !== 'object')
        throw new Error(`validateRow: row ${r.year} missing ${person}`);
      for (const f of DRAWN_FIELDS) {
        if (r[person][f] === undefined)
          throw new Error(`validateRow: row ${r.year} ${person}.${f} is undefined`);
      }
    }

    // Snap object must exist and contain all ten wrapper balance fields.
    const SNAP_FIELDS = ['p1Cash','p1IntBal','p1GIA','p1SIPP','p1ISA',
                         'p2Cash','p2IntBal','p2GIA','p2SIPP','p2ISA'];
    if (!r.snap || typeof r.snap !== 'object')
      throw new Error(`validateRow: row ${r.year} missing snap`);
    for (const f of SNAP_FIELDS) {
      if (r.snap[f] === undefined)
        throw new Error(`validateRow: row ${r.year} snap.${f} is undefined`);
    }
  }

  // ─────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────

  window.RetireCalcRenderLogic = {
    adj,
    grossFn,
    taxFn,
    validateRow,
    buildIncomeDatasets,
    buildEngineShortfall,
    buildGrossNetDatasets,
    buildTaxChartData,
    buildWealthDatasets,
    buildTableTaxRows,
    buildTableWealthRows,
    buildMetrics,
  };
})();
