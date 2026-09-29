/**
 * mortgage.js - pure calculation library (no DOM, no dependencies).
 *
 * UNITS: money is in plain dollars. Every rate/percentage inside this file is a
 * DECIMAL (7% is 0.07). The UI/params layer converts from percent (see params.js).
 *
 * THE MODEL (monthly simulation, month 1 ... horizon*12), for two loans A and B:
 *
 * 1. Loan amount = price - down payment. Fixed-rate amortization:
 *    payment = P*r / (1 - (1+r)^-n), with r = annualRate/12 and n = term months.
 *    A 0% rate is handled (payment = P/n). After payoff the payment is 0.
 *
 * 2. Equal cash. Both scenarios spend exactly the same money:
 *    - Day 0: total cash = max(downA, downB). The scenario with the smaller
 *      down payment invests the difference immediately.
 *    - Every month: budget = max(paymentA, paymentB) of that month. Each
 *      scenario invests (budget - its own payment). Once a loan is paid off, that
 *      side invests its whole former payment while the other loan still has
 *      payments. When both are paid off, nothing new is invested.
 *
 * 3. Portfolio growth: monthly rate = (1+annualReturn)^(1/12) - 1. Each month the
 *    existing balance grows FIRST, then that month's contribution is added
 *    (so a contribution starts earning the following month).
 *
 * 4. Mortgage interest deduction (if enabled), per loan year (months 1-12, 13-24, ...):
 *    - deductible interest = interest paid that year * min(1, cap / average balance)
 *    - tax benefit = marginalRate * max(0, deductible + otherItemized
 *                                          - max(standardDeduction, otherItemized))
 *      (only the amount by which itemizing beats the standard deduction).
 *    - The benefit is invested at the END of that year.
 *    "Average balance" = mean of the 12 balances at the START of each month.
 *
 * 5. At the horizon (a stop point, no refinancing):
 *    - home value = price * (1+appreciation)^years
 *    - home equity (net) = home value * (1 - sellingCost) - remaining loan balance
 *    - portfolio after tax = value - gainsTax * max(0, value - contributions)
 *    - net worth = home equity (net) + portfolio after tax
 *    "contributions" is the cost basis: the initial investment, all monthly
 *    investments and the invested tax benefits.
 *    "cash spent" is out-of-pocket money only: down payment + mortgage payments +
 *    invested cash (tax benefits are refunds, so they are not counted). This is
 *    identical for A and B and is shown as a sanity check.
 *
 * 6. Yearly snapshots (year 0..horizon) are computed with the same formulas as if
 *    the house were sold at the end of that year.
 *
 * 7. Break-even: crossover years where (netWorthB - netWorthA) changes sign, and
 *    the investment return at which both net worths are equal at the horizon
 *    (found by bisection, re-running the full simulation).
 */

/**
 * Monthly principal-and-interest payment of a fixed-rate loan.
 * @param {number} principal Amount borrowed, dollars.
 * @param {number} annualRate Nominal annual interest rate, decimal (0.06 = 6%).
 * @param {number} termYears Loan length in years.
 * @returns {number} Payment per month, dollars.
 * @example
 * monthlyPayment(800000, 0.06, 15); // about 6750.85
 */
export function monthlyPayment(principal, annualRate, termYears) {
  const months = termYears * 12;
  if (principal <= 0) return 0;
  if (annualRate === 0) return principal / months;
  const r = annualRate / 12;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
}

/**
 * Month-by-month amortization schedule, padded with zero months after payoff.
 * @param {number} principal Amount borrowed, dollars.
 * @param {number} annualRate Nominal annual rate, decimal.
 * @param {number} termYears Loan length in years.
 * @param {number} months How many months to return (e.g. the horizon * 12).
 * @returns {{payment:number, interest:number, principal:number, openingBalance:number, balance:number}[]}
 *   One entry per month; `balance` is the balance after that month's payment.
 * @example
 * amortize(100000, 0.06, 30, 360)[0]; // { payment: 599.55, interest: 500, principal: 99.55, ... }
 */
export function amortize(principal, annualRate, termYears, months) {
  const termMonths = termYears * 12;
  const payment = monthlyPayment(principal, annualRate, termYears);
  const r = annualRate / 12;
  const schedule = [];
  let balance = principal;
  for (let m = 1; m <= months; m++) {
    const openingBalance = balance;
    if (m > termMonths || balance <= 0) {
      schedule.push({ payment: 0, interest: 0, principal: 0, openingBalance: 0, balance: 0 });
      balance = 0;
      continue;
    }
    const interest = balance * r;
    const principalPaid = payment - interest;
    balance = openingBalance - principalPaid;
    if (m === termMonths || balance < 0.005) balance = 0; // absorb floating-point dust
    schedule.push({ payment, interest, principal: principalPaid, openingBalance, balance });
  }
  return schedule;
}

/**
 * Equivalent monthly growth rate for an annual return (compounding).
 * @param {number} annualReturn Annual return, decimal (0.07 = 7%).
 * @returns {number} Monthly rate, decimal.
 * @example
 * monthlyGrowthRate(0.07); // about 0.005654
 */
export function monthlyGrowthRate(annualReturn) {
  return Math.pow(1 + annualReturn, 1 / 12) - 1;
}

/**
 * Share of interest that is deductible given the deductible-loan cap.
 * @param {number} cap Deductible loan cap, dollars.
 * @param {number} averageBalance Average loan balance during the year, dollars.
 * @returns {number} A fraction between 0 and 1.
 * @example
 * deductibleFraction(750000, 1000000); // 0.75
 */
export function deductibleFraction(cap, averageBalance) {
  if (averageBalance <= 0) return 1;
  return Math.min(1, cap / averageBalance);
}

/**
 * Income-tax saved in one year by itemizing mortgage interest.
 * @param {object} a
 * @param {number} a.interest Interest paid this year, dollars.
 * @param {number} a.averageBalance Average loan balance this year, dollars.
 * @param {number} a.cap Deductible loan cap, dollars.
 * @param {number} a.marginalRate Marginal income tax rate, decimal.
 * @param {number} a.otherItemized Other itemized deductions per year, dollars.
 * @param {number} a.standardDeduction Standard deduction, dollars.
 * @returns {number} Tax saved this year, dollars (never negative).
 * @example
 * // 40,000 interest + 10,000 other vs 32,200 standard: 17,800 extra * 32% = 5,696
 * yearlyTaxBenefit({interest: 40000, averageBalance: 600000, cap: 750000,
 *   marginalRate: 0.32, otherItemized: 10000, standardDeduction: 32200}); // 5696
 */
export function yearlyTaxBenefit({ interest, averageBalance, cap, marginalRate, otherItemized, standardDeduction }) {
  const deductibleInterest = interest * deductibleFraction(cap, averageBalance);
  const itemized = deductibleInterest + otherItemized;
  const extraOverStandard = itemized - Math.max(standardDeduction, otherItemized);
  return marginalRate * Math.max(0, extraOverStandard);
}

/**
 * Sell-today numbers (home equity, portfolio after tax, net worth) for one snapshot.
 * @param {object} row Snapshot with `balance`, `portfolio`, `contributions`.
 * @param {number} year Years since purchase.
 * @param {object} params Model params (decimals), see simulate().
 * @returns {{homeValue:number, homeEquity:number, portfolioAfterTax:number, netWorth:number}}
 * @example
 * // price 1,000,000, 0% growth, 0% costs, 400,000 owed, 100,000 portfolio (no gain)
 * valueAtYear({balance: 400000, portfolio: 100000, contributions: 100000}, 0,
 *   {price: 1e6, appreciation: 0, sellingCost: 0, gainsTax: 0.2}).netWorth; // 700000
 */
export function valueAtYear(row, year, params) {
  const homeValue = params.price * Math.pow(1 + params.appreciation, year);
  const homeEquity = homeValue * (1 - params.sellingCost) - row.balance;
  const gains = Math.max(0, row.portfolio - row.contributions);
  const portfolioAfterTax = row.portfolio - params.gainsTax * gains;
  return { homeValue, homeEquity, portfolioAfterTax, netWorth: homeEquity + portfolioAfterTax };
}

/**
 * Run one scenario (one loan + its investment account) year by year.
 * @param {object} params Model params (decimals).
 * @param {object} loan `{down, termYears, rate}`.
 * @param {ReturnType<typeof amortize>} schedule This loan's monthly schedule.
 * @param {number[]} budget Total monthly housing budget for each month, dollars.
 * @param {number} initialInvestment Cash invested on day 0, dollars.
 * @returns {object[]} Snapshots for year 0..horizon (see simulate() for fields).
 * @example
 * // internal helper; see simulate()
 */
function runScenario(params, loan, schedule, budget, initialInvestment) {
  const growth = monthlyGrowthRate(params.investReturn);
  const loanAmount = params.price - loan.down;
  let portfolio = initialInvestment;
  let contributions = initialInvestment;
  let cashSpent = loan.down + initialInvestment;
  let cumInterest = 0, cumPrincipal = 0, cumBenefit = 0;

  const makeRow = (year, extra) => {
    const row = {
      year, balance: year === 0 ? loanAmount : schedule[year * 12 - 1].balance,
      portfolio, contributions, cashSpent, cumInterest, cumPrincipal, cumBenefit,
      yearInterest: 0, yearPrincipal: 0, yearBenefit: 0, ...extra,
    };
    return { ...row, ...valueAtYear(row, year, params) };
  };

  const rows = [makeRow(0)];
  for (let year = 1; year <= params.horizonYears; year++) {
    let yearInterest = 0, yearPrincipal = 0, balanceSum = 0;
    for (let m = 0; m < 12; m++) {
      const index = (year - 1) * 12 + m;
      const month = schedule[index];
      const contribution = budget[index] - month.payment;
      portfolio = portfolio * (1 + growth) + contribution; // grow first, then add
      contributions += contribution;
      cashSpent += month.payment + contribution;
      yearInterest += month.interest;
      yearPrincipal += month.principal;
      balanceSum += month.openingBalance;
    }
    const yearBenefit = params.deductInterest
      ? yearlyTaxBenefit({
          interest: yearInterest, averageBalance: balanceSum / 12, cap: params.loanCap,
          marginalRate: params.marginalRate, otherItemized: params.otherItemized,
          standardDeduction: params.standardDeduction,
        })
      : 0;
    portfolio += yearBenefit; // cash back, invested at year end
    contributions += yearBenefit;
    cumInterest += yearInterest;
    cumPrincipal += yearPrincipal;
    cumBenefit += yearBenefit;
    rows.push(makeRow(year, { yearInterest, yearPrincipal, yearBenefit }));
  }
  return rows;
}

/**
 * Collect one field from every snapshot row.
 * @param {object[]} rows Snapshots.
 * @param {string} key Field name.
 * @returns {number[]} Values in year order.
 * @example
 * pluck([{a: 1}, {a: 2}], 'a'); // [1, 2]
 */
export function pluck(rows, key) {
  return rows.map((row) => row[key]);
}

/**
 * Simulate both loans and return results plus chart series.
 * @param {object} params Model params, all rates as decimals:
 *   price, appreciation, horizonYears, investReturn, gainsTax, sellingCost,
 *   deductInterest (boolean), marginalRate, standardDeduction, otherItemized,
 *   loanCap, conformingLimit, and loanA / loanB = {label, down, termYears, rate}.
 * @returns {{A:object, B:object, series:object}} For each loan: label, loanAmount,
 *   monthlyPayment, isJumbo, rows (yearly snapshots) and final (last row).
 *   `series` holds arrays indexed by year 0..horizon.
 * @example
 * const r = simulate(defaultModelParams);
 * r.A.final.netWorth; // dollars at the horizon
 */
export function simulate(params) {
  const months = params.horizonYears * 12;
  const loans = [params.loanA, params.loanB];
  const amounts = loans.map((loan) => params.price - loan.down);
  const schedules = loans.map((loan, i) => amortize(amounts[i], loan.rate, loan.termYears, months));
  const budget = schedules[0].map((month, i) => Math.max(month.payment, schedules[1][i].payment));
  const totalCash = Math.max(params.loanA.down, params.loanB.down);

  const results = loans.map((loan, i) => {
    const rows = runScenario(params, loan, schedules[i], budget, totalCash - loan.down);
    return {
      label: loan.label,
      loanAmount: amounts[i],
      monthlyPayment: monthlyPayment(amounts[i], loan.rate, loan.termYears),
      isJumbo: amounts[i] > params.conformingLimit,
      rows,
      final: rows[rows.length - 1],
    };
  });

  const seriesFor = (rows) => ({
    netWorth: pluck(rows, 'netWorth'), balance: pluck(rows, 'balance'),
    cumInterest: pluck(rows, 'cumInterest'), cumPrincipal: pluck(rows, 'cumPrincipal'),
    portfolio: pluck(rows, 'portfolio'), contributions: pluck(rows, 'contributions'),
    yearInterest: pluck(rows, 'yearInterest'),
    yearPrincipal: pluck(rows, 'yearPrincipal'),
  });
  const years = results[0].rows.map((row) => row.year);
  return { A: results[0], B: results[1], series: { years, A: seriesFor(results[0].rows), B: seriesFor(results[1].rows) } };
}

/**
 * Years where the lead changes between A and B.
 * @param {number[]} netWorthA Net worth of A per year (index = year).
 * @param {number[]} netWorthB Net worth of B per year.
 * @returns {{year:number, winner:'A'|'B'}[]} Each year the sign of (B - A) flips;
 *   `winner` is who is ahead from that year on. Exact ties are skipped.
 * @example
 * findCrossovers([0, 10, 20], [5, 8, 30]); // [{year: 1, winner: 'A'}, {year: 2, winner: 'B'}]
 */
export function findCrossovers(netWorthA, netWorthB) {
  const crossovers = [];
  let lastSign = 0;
  netWorthA.forEach((a, year) => {
    const diff = netWorthB[year] - a;
    const sign = Math.sign(diff);
    if (sign !== 0 && lastSign !== 0 && sign !== lastSign) {
      crossovers.push({ year, winner: sign > 0 ? 'B' : 'A' });
    }
    if (sign !== 0) lastSign = sign;
  });
  return crossovers;
}

/**
 * Net worth of B minus A at the horizon.
 * @param {object} params Model params (see simulate()).
 * @returns {number} Dollars; positive means B is ahead.
 * @example
 * netWorthGap(defaultModelParams); // e.g. -23000
 */
export function netWorthGap(params) {
  const result = simulate(params);
  return result.B.final.netWorth - result.A.final.netWorth;
}

/**
 * Investment return at which A and B end with equal net worth (bisection).
 * @param {object} params Model params (see simulate()); investReturn is overridden.
 * @param {number} [low=-0.10] Lowest return to try, decimal.
 * @param {number} [high=0.30] Highest return to try, decimal.
 * @returns {number|null} Break-even annual return as a decimal, or null if the
 *   gap does not change sign inside [low, high].
 * @example
 * breakEvenReturn(defaultModelParams); // e.g. 0.0653 (6.53%)
 */
export function breakEvenReturn(params, low = -0.10, high = 0.30) {
  const gapAt = (r) => netWorthGap({ ...params, investReturn: r });
  let gapLow = gapAt(low);
  const gapHigh = gapAt(high);
  if (gapLow === 0) return low;
  if (gapHigh === 0) return high;
  if (Math.sign(gapLow) === Math.sign(gapHigh)) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    const gapMid = gapAt(mid);
    if (Math.sign(gapMid) === Math.sign(gapLow)) { low = mid; gapLow = gapMid; } else { high = mid; }
  }
  return (low + high) / 2;
}
