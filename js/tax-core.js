export function calculateTax(input, rules) {
  const {
    salary = 0,
    interest = 0,
    dividends = 0
  } = input;

  const {
    personalAllowance,
    basicRateLimit,
    higherRateLimit,

    incomeTaxRates,
    dividendRates,

    savings: {
      startingRateLimit,
      personalSavingsAllowanceBasic,
      personalSavingsAllowanceHigher
    },

    dividendAllowance,

    ni: {
      primaryThreshold,
      rate
    }
  } = rules;

  let remainingPA = personalAllowance;

  // -------------------------
  // 1. Apply Personal Allowance
  // -------------------------

  const salaryPA = Math.min(salary, remainingPA);
  remainingPA -= salaryPA;

  const interestPA = Math.min(interest, remainingPA);
  remainingPA -= interestPA;

  const dividendPA = Math.min(dividends, remainingPA);
  remainingPA -= dividendPA;

  let taxableSalary = salary - salaryPA;
  let taxableInterest = interest - interestPA;
  let taxableDividends = dividends - dividendPA;

  // -------------------------
  // 2. Taxable non-savings income
  // -------------------------

  const nonSavingsIncome = taxableSalary;

  // -------------------------
  // 3. Starting Rate for Savings (SRS)
  // -------------------------

  let srsAvailable = Math.max(
    0,
    startingRateLimit - Math.max(0, nonSavingsIncome)
  );

  const srsUsed = Math.min(taxableInterest, srsAvailable);
  taxableInterest -= srsUsed;

  // -------------------------
  // 4. Personal Savings Allowance (PSA)
  // -------------------------

  const totalIncome =
    taxableSalary + taxableInterest + taxableDividends;

  let psa = 0;

  if (totalIncome <= basicRateLimit) {
    psa = personalSavingsAllowanceBasic;
  } else if (totalIncome <= higherRateLimit) {
    psa = personalSavingsAllowanceHigher;
  }

  const psaUsed = Math.min(psa, taxableInterest);
  taxableInterest -= psaUsed;

  // -------------------------
  // 5. Dividend allowance
  // -------------------------

  const dividendAllowanceUsed = Math.min(
    dividendAllowance,
    taxableDividends
  );

  taxableDividends -= dividendAllowanceUsed;

  // -------------------------
  // 6. Apply tax bands
  // -------------------------

  let remainingBasicBand = basicRateLimit;
  let remainingHigherBand = higherRateLimit - basicRateLimit;

  let incomeTax = 0;
  let savingsTax = 0;
  let dividendTax = 0;

  // ---- Salary first
  let salaryBasic = Math.min(taxableSalary, remainingBasicBand);
  incomeTax += salaryBasic * incomeTaxRates.basic;
  remainingBasicBand -= salaryBasic;

  let salaryHigher = Math.min(
    taxableSalary - salaryBasic,
    remainingHigherBand
  );
  incomeTax += salaryHigher * incomeTaxRates.higher;
  remainingHigherBand -= salaryHigher;

  let salaryAdditional =
    taxableSalary - salaryBasic - salaryHigher;

  incomeTax += salaryAdditional * incomeTaxRates.additional;

  // ---- Interest next
  let interestBasic = Math.min(
    taxableInterest,
    remainingBasicBand
  );
  savingsTax += interestBasic * incomeTaxRates.basic;
  remainingBasicBand -= interestBasic;

  let interestHigher = Math.min(
    taxableInterest - interestBasic,
    remainingHigherBand
  );
  savingsTax += interestHigher * incomeTaxRates.higher;
  remainingHigherBand -= interestHigher;

  let interestAdditional =
    taxableInterest - interestBasic - interestHigher;

  savingsTax +=
    interestAdditional * incomeTaxRates.additional;

  // ---- Dividends last
  let dividendBasic = Math.min(
    taxableDividends,
    remainingBasicBand
  );
  dividendTax +=
    dividendBasic * dividendRates.basic;
  remainingBasicBand -= dividendBasic;

  let dividendHigher = Math.min(
    taxableDividends - dividendBasic,
    remainingHigherBand
  );
  dividendTax +=
    dividendHigher * dividendRates.higher;
  remainingHigherBand -= dividendHigher;

  let dividendAdditional =
    taxableDividends - dividendBasic - dividendHigher;

  dividendTax +=
    dividendAdditional * dividendRates.additional;

  // -------------------------
  // 7. National Insurance
  // -------------------------

  let ni = 0;

  if (salary > primaryThreshold) {
    ni = (salary - primaryThreshold) * rate;
  }

  // -------------------------
  // Final
  // -------------------------

  const total =
    incomeTax + savingsTax + dividendTax + ni;

  return {
    incomeTax: round(incomeTax),
    savingsTax: round(savingsTax),
    dividendTax: round(dividendTax),
    ni: round(ni),
    total: round(total)
  };
}

// -------------------------
// Helper
// -------------------------

function round(n) {
  return Math.round(n * 100) / 100;
}