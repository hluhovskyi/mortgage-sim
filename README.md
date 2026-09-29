# Mortgage strategy comparison

A static page that compares two mortgage strategies with the same total cash, for example
"15-year fixed, big down payment" versus "30-year fixed (maybe jumbo), small down payment,
invest the rest in the S&P 500". It shows who ends with more net worth, the break-even
investment return, and charts and a yearly table so every number can be checked.

No build step, no framework, no server logic, no dependencies (Chart.js is loaded from cdnjs).

## Run locally

```
python3 -m http.server
# then open http://localhost:8000
```

Opening `index.html` directly (`file://`) will not work because browsers block ES modules there.

Tests: `node --test` (or `npm test`). No install needed.

## Files

- `lib/mortgage.js` - pure calculation library (no DOM). Percentages are decimals here.
- `lib/params.js` - defaults, URL parsing/writing, percent-to-decimal conversion.
- `test/mortgage.test.js` - tests using Node's built-in runner.
- `index.html`, `app.js`, `styles.css` - the UI.

## URL parameters

Every input is synced to the URL (`history.replaceState`). Values are percent numbers or dollars.
Unknown keys are ignored; invalid values fall back to the default; numbers are clamped to the range shown.

| Key | Meaning | Default | Range |
|---|---|---|---|
| `p` | House price, $ | 1000000 | 10,000 - 100,000,000 |
| `g` | Home appreciation, % / yr | 3 | -10 - 20 |
| `y` | Horizon (sell or stop at year) | 30 | 1 - 40 (whole years) |
| `r` | Investment return, % / yr, nominal | 7 | -20 - 40 |
| `gt` | Tax on investment gains, % | 23.8 | 0 - 60 |
| `sc` | Selling costs, % of home value | 7 | 0 - 30 |
| `ded` | Deduct mortgage interest (1 or 0) | 1 | 0 or 1 |
| `mt` | Marginal income tax rate, % | 32 | 0 - 60 |
| `sd` | Standard deduction, $ | 32200 | 0 - 10,000,000 |
| `oi` | Other itemized deductions, $ / yr | 10000 | 0 - 10,000,000 |
| `cap` | Deductible loan cap, $ | 750000 | 0 - 100,000,000 |
| `cl` | Conforming loan limit, $ (label only) | 832750 | 0 - 100,000,000 |
| `al` / `bl` | Loan A / B label (max 30 chars) | Loan A / Loan B | text |
| `ad` / `bd` | Loan A / B down payment, $ (capped at price) | 400000 / 100000 | 0 - 100,000,000 |
| `at` / `bt` | Loan A / B term, years | 15 / 30 | 1 - 40 |
| `ar` / `br` | Loan A / B interest rate, % | 6 / 6.75 | 0 - 25 |

## Model

Monthly simulation, month 1 to horizon x 12.

1. **Loans.** Loan amount = price - down payment. Standard fixed-rate payment
   `P*r / (1 - (1+r)^-n)`, `r = rate/12`; a 0% rate is handled. After payoff the payment is 0.
2. **Equal cash.** Day 0 total cash = max(downA, downB); the smaller down payment invests the
   difference immediately. Each month the budget is max(paymentA, paymentB); each scenario invests
   budget - its own payment. When one loan is paid off, that side invests its whole former payment
   while the other still has payments. When both are paid off, nothing new is invested.
3. **Portfolio growth.** Monthly rate = (1+annual)^(1/12) - 1, applied to the balance first, then
   that month's contribution is added.
4. **Mortgage interest deduction** (optional), per loan year:
   deductible interest = interest x min(1, cap / average balance) (average of the 12 opening monthly balances);
   tax benefit = marginal rate x max(0, deductible + other itemized - max(standard deduction, other itemized)).
   The benefit is invested at the end of that year.
5. **Horizon.** Home value = price x (1+appreciation)^years. Home equity (net) = home value x (1 - selling cost) - loan balance.
   Portfolio after tax = value - gains tax x max(0, value - contributions). Net worth = home equity (net) + portfolio after tax.
   Both loans are simply settled from sale proceeds; there is no refinancing.
6. **Series.** Yearly snapshots (year 0..horizon) use the same formulas, as if sold that year.
7. **Break-even.** Crossover years are where (net worth B - net worth A) changes sign. The break-even return is found by
   bisection between -10% and 30% by re-running the full simulation; it is null if the gap does not change sign there.

### Decisions beyond the spec

- "Contributions" (cost basis for the gains tax) include the invested tax benefits, since that money is invested and was not
  taxed as a gain. "Total cash spent" counts only out-of-pocket money (down payment, payments, cash invested); it is the same for A and B.
- Down payments larger than the price are capped at the price (loan of 0).
- Exact ties are ignored when looking for crossover years. Year 0 (day of purchase, after selling costs) is part of the series.

### Not modeled

Market volatility and sequence of returns (returns are a smooth average), PMI, closing costs and points, refinancing,
inflation, liquidity, loan qualification or income limits, changes in tax law, state taxes, property tax or insurance changes,
rent alternatives.
