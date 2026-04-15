(function () {

  // ─────────────────────────────────────────────
  // LABEL → ELEMENT ID MAP
  // Parameters sheet col A (human label) → DOM element ID
  // ─────────────────────────────────────────────
  const PARAM_MAP = {
    'Person 1 – birth year':                    'p1DOB',
    'Person 2 – birth year':                    'p2DOB',
    'Person 1 name':                            'p1name',
    'Person 2 name':                            'p2name',
    'Start year':                               'startYear',
    'End year':                                 'endYear',
    'Annual household spending (£)':            'spending',
    'Step-down at age 75 (%)':                  'stepDownPct',
    'Person 1 – gross annual salary (£)':       'p1Salary',
    'Person 1 – salary stop age':               'p1SalaryStopAge',
    'Gross annual salary (£)':                  'p2Salary',
    'Stop age':                                 'p2SalaryStopAge',
    'Person 1 – start age':                     'p1SPAge',
    'Person 1 – annual amount (£)':             'p1SP',
    'Person 2 – start age':                     'p2SPAge',
    'Person 2 – annual amount (£)':             'p2SP',
    'Portfolio growth (%/yr)':                  'growth',
    'Inflation (%/yr)':                         'inflation',
    'Threshold uprating mode':                  'thresholdMode',
    'Uprate from year':                         'thresholdFromYearVal',
    'Enable bed-and-ISA':                       'bniEnabled',
    'Person 1 GIA→ISA per year (£)':            'bniP1GIA',
    'Person 2 GIA→ISA per year (£)':            'bniP2GIA',
  };

  // Reverse map: human label keyed by elementId — used for friendly error messages
  const ID_TO_LABEL = Object.fromEntries(
    Object.entries(PARAM_MAP).map(([label, id]) => [id, label])
  );

  const REQUIRED_IDS = ['p1DOB', 'p2DOB', 'startYear', 'endYear', 'spending'];

  // ─────────────────────────────────────────────
  // FUZZY LABEL LOOKUP (Option B)
  // Normalise: lowercase, collapse whitespace, strip –-()£%/
  // Pre-computed once at module load.
  // ─────────────────────────────────────────────
  function normaliseLabel(s) {
    return s
      .toLowerCase()
      .replace(/[–\-\(\)£%\/]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const NORMALISED_PARAM_MAP = Object.fromEntries(
    Object.entries(PARAM_MAP).map(([label, id]) => [normaliseLabel(label), id])
  );

  // ─────────────────────────────────────────────
  // WRAPPER NORMALISATION
  // Accept SIPP/WP as a synonym for SIPP.
  // Normalise to canonical form before storage.
  // ─────────────────────────────────────────────
  const WRAPPER_SYNONYMS = {
    'SIPP/WP': 'SIPP',
  };

  const VALID_WRAPPERS = new Set(['ISA', 'SIPP', 'GIA', 'Cash']);

  function normaliseWrapper(raw) {
    const trimmed = String(raw || '').trim();
    // Try exact match first (preserves 'Cash' mixed-case)
    if (VALID_WRAPPERS.has(trimmed)) return trimmed;
    // Try case-insensitive synonym lookup
    const upper = trimmed.toUpperCase();
    for (const [synonym, canonical] of Object.entries(WRAPPER_SYNONYMS)) {
      if (upper === synonym.toUpperCase()) return canonical;
    }
    // Try case-insensitive match against valid wrappers
    for (const w of VALID_WRAPPERS) {
      if (w.toUpperCase() === upper) return w;
    }
    // Return original (will fail validation with a clear message)
    return trimmed;
  }

  // Allocation defaults by wrapper
  const ALLOC_DEFAULTS = {
    ISA:  { equities: 100, bonds: 0, cashlike: 0, cash: 0 },
    SIPP: { equities: 100, bonds: 0, cashlike: 0, cash: 0 },
    GIA:  { equities: 100, bonds: 0, cashlike: 0, cash: 0 },
    Cash: { equities: 0,   bonds: 0, cashlike: 0, cash: 100 },
  };

  // ─────────────────────────────────────────────
  // PUBLIC: trigger file picker
  // ─────────────────────────────────────────────
  function openFilePicker() {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = '.xlsx,.xls';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (file) readFile(file);
      document.body.removeChild(input);
    });
    input.click();
  }

  // ─────────────────────────────────────────────
  // READ FILE via SheetJS
  // ─────────────────────────────────────────────
  function readFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb   = XLSX.read(data, { type: 'array' });
        parseWorkbook(wb);
      } catch (err) {
        console.error('Excel load error:', err);
        alert('Failed to read Excel file – see console.');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ─────────────────────────────────────────────
  // PARSE WORKBOOK
  // ─────────────────────────────────────────────
  function parseWorkbook(wb) {
    const accounts = parseAccounts(wb);
    const params   = parseParams(wb);
    const errors   = validate(accounts, params);

    if (errors.length) {
      alert('Excel load issues:\n\n' + errors.join('\n'));
      return;
    }

    document.dispatchEvent(new CustomEvent('excel-loaded', {
      detail: { accounts, params }
    }));
  }

  // ─────────────────────────────────────────────
  // SHEET 1 — Accounts
  // Columns: name, wrapper, owner, value,
  //          equities, bonds, cashlike, cash,
  //          rate, monthlyDraw, notes (ignored)
  // Row 1 = title, Row 2 = headers, Row 3+ = data
  // ─────────────────────────────────────────────
  function parseAccounts(wb) {
    const sheet = wb.Sheets['Accounts'];
    if (!sheet) throw new Error('No "Accounts" sheet found.');

    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      range:  2,
    });

    const accounts = [];

    rows.forEach((row) => {
      const name    = String(row[0] || '').trim();
      const wrapper = normaliseWrapper(row[1]);
      // Skip rows with no name or unrecognisable wrapper
      if (!name || (!VALID_WRAPPERS.has(wrapper) && wrapper === String(row[1] || '').trim())) {
        // If name is present but wrapper is unrecognisable, still push so validate() can report it
        if (name) {
          accounts.push({ name, wrapper, owner: String(row[2] || 'p1').trim(),
            value: parseNum(row[3]),
            alloc: { equities: 0, bonds: 0, cashlike: 0, cash: 0 },
            rate: null, monthlyDraw: null, _rawWrapper: String(row[1] || '').trim() });
        }
        return;
      }
      if (!name) return;

      const owner       = String(row[2] || 'p1').trim();
      const value       = parseNum(row[3]);
      const equities    = parseNum(row[4]);
      const bonds       = parseNum(row[5]);
      const cashlike    = parseNum(row[6]);
      const cash        = parseNum(row[7]);
      const rate        = row[8] !== '' && row[8] !== null ? parseNum(row[8]) : null;
      const monthlyDraw = row[9] !== '' && row[9] !== null ? parseNum(row[9]) : null;

      // Apply wrapper-based allocation defaults when all four columns are blank/zero
      const allAllocBlank = [row[4], row[5], row[6], row[7]]
        .every(v => v === '' || v === null || v === undefined);
      const alloc = allAllocBlank
        ? { ...ALLOC_DEFAULTS[wrapper] }
        : { equities, bonds, cashlike, cash };

      accounts.push({ name, wrapper, owner, value, alloc, rate, monthlyDraw });
    });

    return accounts;
  }

  // ─────────────────────────────────────────────
  // SHEET 2 — Parameters
  // Reads cells directly by address to avoid SheetJS merged-cell row issues.
  // Supports both formats:
  //   Old: col A = label, col B = key(elementId), col C = value
  //   New: col A = label, col B = value
  // Auto-detected by col B row-2 header text.
  // New format uses fuzzy (normalised) label matching.
  // ─────────────────────────────────────────────
  function parseParams(wb) {
    const sheet = wb.Sheets['Parameters'];
    if (!sheet) throw new Error('No "Parameters" sheet found.');

    const range = XLSX.utils.decode_range(sheet['!ref']);
    const maxRow = range.e.r;

    // Read header row (row index 1 = sheet row 2) col B to detect format
    const headerBCell = sheet[XLSX.utils.encode_cell({ r: 1, c: 1 })];
    const headerB = headerBCell ? String(headerBCell.v || '') : '';
    const isOldFormat = headerB.toLowerCase().includes('key');

    const params = {};

    for (let r = 2; r <= maxRow; r++) {
      const cellA = sheet[XLSX.utils.encode_cell({ r, c: 0 })];
      const cellB = sheet[XLSX.utils.encode_cell({ r, c: 1 })];
      const cellC = sheet[XLSX.utils.encode_cell({ r, c: 2 })];

      const valB = cellB ? cellB.v : null;
      const valC = cellC ? cellC.v : null;

      if (isOldFormat) {
        const key = String(valB || '').trim();
        if (!key) continue;
        params[key] = (valC !== null && valC !== undefined) ? valC : '';
      } else {
        const valA = cellA ? cellA.v : null;
        const label = String(valA || '').trim();
        if (!label) continue;
        // Fuzzy match: normalise the cell label before lookup
        const elementId = NORMALISED_PARAM_MAP[normaliseLabel(label)];
        if (!elementId) continue;
        params[elementId] = (valB !== null && valB !== undefined) ? valB : '';
      }
    }

    return params;
  }

  // ─────────────────────────────────────────────
  // VALIDATE
  // ─────────────────────────────────────────────
  function validate(accounts, params) {
    const errors = [];
    const validOwners = new Set(['p1', 'p2']);

    accounts.forEach((a, i) => {
      const r = i + 3;
      const label = `Row ${r} "${a.name}"`;

      if (!VALID_WRAPPERS.has(a.wrapper)) {
        const raw = a._rawWrapper || a.wrapper;
        errors.push(
          `Accounts ${label}: wrapper "${raw}" not recognised — use ISA, SIPP, SIPP/WP (workplace pension), GIA, or Cash`
        );
      }

      if (!validOwners.has(a.owner)) {
        errors.push(
          `Accounts ${label}: owner "${a.owner}" not recognised — use p1 or p2`
        );
      }

      const { equities, bonds, cashlike, cash } = a.alloc;
      const allocTotal = equities + bonds + cashlike + cash;
      if (Math.abs(allocTotal - 100) > 1) {
        errors.push(
          `Accounts ${label}: allocation adds to ${allocTotal.toFixed(1)}% ` +
          `(equities ${equities} + bonds ${bonds} + cash-like ${cashlike} + cash ${cash}) — must total 100%`
        );
      }
    });

    REQUIRED_IDS.forEach(id => {
      if (params[id] === undefined || params[id] === '') {
        const humanLabel = ID_TO_LABEL[id] || id;
        errors.push(`Parameters: "${humanLabel}" is required but missing`);
      }
    });

    return errors;
  }

  // ─────────────────────────────────────────────
  // TEMPLATE DOWNLOAD
  // Generates a two-sheet .xlsx with headers,
  // example rows, and a Notes column on each sheet.
  // ─────────────────────────────────────────────
  function downloadTemplate() {
    const wb = XLSX.utils.book_new();

    // ── Accounts sheet ──────────────────────────
    const accountsData = [
      // Row 1: title
      ['Accounts — UK Retirement Tax Planner'],
      // Row 2: headers
      [
        'Name',
        'Wrapper',
        'Owner',
        'Value (£)',
        'Equities %',
        'Bonds %',
        'Cash-like %',
        'Cash %',
        'Interest rate %',
        'Monthly draw (£)',
        'Notes',
      ],
      // Example row 1: SIPP
      [
        'Woody SIPP',
        'SIPP',
        'p1',
        481423,
        100, 0, 0, 0,
        '',
        '',
        'SIPP = Self-Invested Personal Pension. Use SIPP/WP for a Workplace Pension. Owner: p1 or p2. Allocation % must total 100 — leave all blank to use default (100% equities for SIPP/ISA/GIA, 100% cash for Cash).',
      ],
      // Example row 2: ISA
      [
        'Woody ISA',
        'ISA',
        'p1',
        273585,
        100, 0, 0, 0,
        '',
        '',
        '',
      ],
      // Example row 3: Workplace pension
      [
        'Heidi Workplace Pension',
        'SIPP/WP',
        'p2',
        201891,
        100, 0, 0, 0,
        '',
        '',
        'SIPP/WP = Workplace Pension — treated identically to SIPP for tax purposes.',
      ],
      // Example row 4: GIA
      [
        'Woody GIA',
        'GIA',
        'p1',
        154208,
        100, 0, 0, 0,
        '',
        '',
        '',
      ],
      // Example row 5: Cash savings
      [
        'Woody Cash',
        'Cash',
        'p1',
        96264,
        0, 0, 0, 100,
        4.5,
        '',
        'Cash accounts: set Interest rate % for savings accounts. Allocation defaults to 100% cash if all % columns are left blank.',
      ],
    ];

    const accountsSheet = XLSX.utils.aoa_to_sheet(accountsData);

    // Set column widths for readability
    accountsSheet['!cols'] = [
      { wch: 28 }, // Name
      { wch: 10 }, // Wrapper
      { wch: 7  }, // Owner
      { wch: 12 }, // Value
      { wch: 10 }, // Equities %
      { wch: 8  }, // Bonds %
      { wch: 11 }, // Cash-like %
      { wch: 8  }, // Cash %
      { wch: 14 }, // Interest rate
      { wch: 14 }, // Monthly draw
      { wch: 80 }, // Notes
    ];

    XLSX.utils.book_append_sheet(wb, accountsSheet, 'Accounts');

    // ── Parameters sheet ────────────────────────
    const paramRows = [
      // Row 1: title
      ['Parameters — UK Retirement Tax Planner'],
      // Row 2: headers
      ['Parameter', 'Value', 'Notes'],
      // People
      ['Person 1 name',                         '',   'First name or any label, e.g. Woody'],
      ['Person 2 name',                         '',   'First name or any label, e.g. Heidi'],
      ['Person 1 – birth year',                 '',   'Required. Four-digit year, e.g. 1967'],
      ['Person 2 – birth year',                 '',   'Required. Four-digit year, e.g. 1966'],
      // Projection dates
      ['Start year',                            '',   'Required. First year of projection, e.g. 2025'],
      ['End year',                              '',   'Required. Last year of projection, e.g. 2055'],
      // Spending
      ['Annual household spending (£)',         '',   'Required. Total annual net household spending target, e.g. 45000'],
      ['Step-down at age 75 (%)',               '',   'Optional. % reduction in spending from age 75, e.g. 20'],
      // Salary — Person 1
      ['Person 1 – gross annual salary (£)',    '',   'Optional. Leave blank if not working'],
      ['Person 1 – salary stop age',            '',   'Optional. Age at which salary stops, e.g. 60'],
      // Salary — Person 2
      ['Gross annual salary (£)',               '',   'Optional. Person 2 gross salary'],
      ['Stop age',                              '',   'Optional. Person 2 salary stop age'],
      // State Pension — Person 1
      ['Person 1 – start age',                  '',   'State Pension start age, e.g. 67'],
      ['Person 1 – annual amount (£)',          '',   'State Pension annual amount, e.g. 11502'],
      // State Pension — Person 2
      ['Person 2 – start age',                  '',   'State Pension start age, e.g. 67'],
      ['Person 2 – annual amount (£)',          '',   'State Pension annual amount, e.g. 11502'],
      // Growth & inflation
      ['Portfolio growth (%/yr)',               '',   'Nominal annual portfolio growth rate, e.g. 5'],
      ['Inflation (%/yr)',                      '',   'Annual inflation assumption, e.g. 2.5'],
      ['Threshold uprating mode',               '',   'How tax thresholds are uprated: frozen, cpi, or wages'],
      ['Uprate from year',                      '',   'Year from which uprating applies, e.g. 2028'],
      // Bed and ISA
      ['Enable bed-and-ISA',                   '',   'yes or no — whether to model annual GIA→ISA transfers'],
      ['Person 1 GIA→ISA per year (£)',         '',   'Annual GIA to ISA transfer amount for Person 1, e.g. 20000'],
      ['Person 2 GIA→ISA per year (£)',         '',   'Annual GIA to ISA transfer amount for Person 2, e.g. 20000'],
    ];

    const paramsSheet = XLSX.utils.aoa_to_sheet(paramRows);

    paramsSheet['!cols'] = [
      { wch: 38 }, // Parameter
      { wch: 16 }, // Value
      { wch: 70 }, // Notes
    ];

    XLSX.utils.book_append_sheet(wb, paramsSheet, 'Parameters');

    // Write and trigger download
    XLSX.writeFile(wb, 'retirement-planner-template.xlsx');
  }

  // ─────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────
  function parseNum(v) {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(String(v).replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
  }

  window.RetireExcelLoader = { openFilePicker, downloadTemplate };
})();
