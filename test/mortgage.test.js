import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyPayment, amortize, simulate, yearlyTaxBenefit, deductibleFraction,
  findCrossovers, breakEvenReturn,
} from '../lib/mortgage.js';
import {
  DEFAULTS, defaultModelParams, paramsFromQuery, paramsToQuery, toModelParams,
} from '../lib/params.js';

const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ''} expected ${expected} +-${tolerance}, got ${actual}`);

/** Copy of the default model params with some fields replaced. */
const withChanges = (changes) => ({ ...defaultModelParams, ...changes });

test('monthlyPayment matches known values', () => {
  near(monthlyPayment(800000, 0.06, 15), 6750.85, 1);
  near(monthlyPayment(800000, 0.07, 20), 6202, 2);
});

test('monthlyPayment with 0% rate is principal / months', () => {
  assert.equal(monthlyPayment(360000, 0, 30), 1000);
});

test('amortize ends at zero and sums are consistent', () => {
  const principal = 900000;
  const schedule = amortize(principal, 0.06625, 15, 180);
  assert.equal(schedule.length, 180);
  near(schedule[179].balance, 0, 0.01);
  const interest = schedule.reduce((s, m) => s + m.interest, 0);
  const principalPaid = schedule.reduce((s, m) => s + m.principal, 0);
  const payments = schedule.reduce((s, m) => s + m.payment, 0);
  near(principalPaid, principal, 0.01);
  near(interest + principalPaid, payments, 0.01);
});

test('amortize pads zero payments after payoff', () => {
  const schedule = amortize(100000, 0.05, 15, 240);
  assert.equal(schedule[200].payment, 0);
  assert.equal(schedule[200].balance, 0);
});

test('equal-cash invariant: cash spent is identical for A and B', () => {
  const sets = [
    defaultModelParams,
    withChanges({ horizonYears: 10 }),
    withChanges({ investReturn: 0, deductInterest: false }),
    withChanges({ price: 900000, loanA: { label: 'A', down: 100000, termYears: 20, rate: 0.05 } }),
    withChanges({ horizonYears: 1, loanB: { label: 'B', down: 900000, termYears: 30, rate: 0 } }),
  ];
  for (const params of sets) {
    const r = simulate(params);
    near(r.A.final.cashSpent, r.B.final.cashSpent, 0.01);
  }
});

test('identical loans give identical net worth', () => {
  const loan = { label: 'X', down: 400000, termYears: 30, rate: 0.07 };
  const r = simulate(withChanges({ loanA: loan, loanB: { ...loan } }));
  assert.equal(r.A.final.netWorth, r.B.final.netWorth);
});

test('with 0% investment return, bigger down / shorter loan wins', () => {
  const r = simulate(withChanges({ investReturn: 0 }));
  assert.ok(r.A.final.netWorth > r.B.final.netWorth);
});

test('deduction cap: under cap is fully deductible, over cap is proportional', () => {
  const base = { interest: 40000, cap: 750000, marginalRate: 0.32, otherItemized: 10000, standardDeduction: 32200 };
  assert.equal(deductibleFraction(750000, 600000), 1);
  near(deductibleFraction(750000, 1000000), 0.75, 1e-12);
  const under = yearlyTaxBenefit({ ...base, averageBalance: 600000 });
  near(under, 0.32 * (40000 + 10000 - 32200), 1e-6);
  const over = yearlyTaxBenefit({ ...base, averageBalance: 1000000 });
  near(over, 0.32 * (30000 + 10000 - 32200), 1e-6);
});

test('no tax benefit when itemizing does not beat the standard deduction', () => {
  const b = yearlyTaxBenefit({ interest: 5000, averageBalance: 100000, cap: 750000, marginalRate: 0.32, otherItemized: 10000, standardDeduction: 32200 });
  assert.equal(b, 0);
});

test('findCrossovers reports sign changes', () => {
  assert.deepEqual(findCrossovers([0, 10, 20], [5, 8, 30]), [{ year: 1, winner: 'A' }, { year: 2, winner: 'B' }]);
  assert.deepEqual(findCrossovers([1, 2, 3], [0, 1, 2]), []);
});

test('breakEvenReturn equalizes net worths at the horizon', () => {
  const rate = breakEvenReturn(defaultModelParams);
  assert.notEqual(rate, null);
  const r = simulate({ ...defaultModelParams, investReturn: rate });
  near(r.A.final.netWorth, r.B.final.netWorth, 100);
});

test('Jumbo flag follows the conforming limit', () => {
  const r = simulate(defaultModelParams);
  assert.equal(r.A.isJumbo, false); // 600,000 loan
  assert.equal(r.B.isJumbo, true);  // 900,000 loan
});

test('URL params round-trip', () => {
  const custom = structuredClone(DEFAULTS);
  custom.price = 1200000; custom.horizon = 20; custom.deduct = false; custom.investReturn = 5.5;
  custom.loanA = { label: 'Short', down: 500000, term: 20, rate: 6.1 };
  custom.loanB = { label: 'Long & cheap', down: 100000, term: 30, rate: 7 };
  assert.deepEqual(paramsFromQuery('?' + paramsToQuery(custom)), custom);
  assert.deepEqual(paramsFromQuery(paramsToQuery(DEFAULTS)), DEFAULTS);
});

test('URL params: clamps, ignores unknown keys and bad values', () => {
  const p = paramsFromQuery('?y=99&mt=abc&at=99&bt=x&zzz=5&sc=-4');
  assert.equal(p.horizon, 40);
  assert.equal(p.marginalRate, DEFAULTS.marginalRate);
  assert.equal(p.loanA.term, 40);
  assert.equal(p.loanB.term, DEFAULTS.loanB.term);
  assert.equal(p.sellingCost, 0);
  assert.equal('zzz' in p, false);
});

test('toModelParams converts percent to decimals', () => {
  const m = toModelParams(DEFAULTS);
  assert.equal(m.investReturn, 0.07);
  assert.equal(m.loanB.rate, 0.0675);
});

test('keeping investments skips the gains tax in every year', () => {
  const sold = simulate(defaultModelParams);
  const kept = simulate(withChanges({ keepInvestments: true }));
  for (const row of kept.B.rows) assert.equal(row.portfolioAfterTax, row.portfolio);
  const gainsTax = sold.B.final.portfolio - sold.B.final.portfolioAfterTax;
  assert.ok(gainsTax > 0);
  near(kept.B.final.netWorth, sold.B.final.netWorth + gainsTax, 1e-6);
});

test('keep-investments box: off by default, URL key ki, passed to the model', () => {
  assert.equal(DEFAULTS.keepInvestments, false);
  assert.match(paramsToQuery(DEFAULTS), /(^|&)ki=0(&|$)/);
  const p = paramsFromQuery('?ki=1');
  assert.equal(p.keepInvestments, true);
  assert.equal(toModelParams(p).keepInvestments, true);
});
