// app.js - wires the inputs, the calculation library and the charts together.
// Flow: read inputs -> params -> simulate -> render text, cards, table, charts.

import { simulate, findCrossovers, breakEvenReturn, netWorthGap } from './lib/mortgage.js?v=11';
import {
  FIELDS, paramsFromQuery, paramsToQuery, toModelParams, getPath, setPath, cleanValue,
} from './lib/params.js?v=11';

const $ = (selector) => document.querySelector(selector);

// ---------- formatting ----------
const dollarFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const compactFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const money = (n) => dollarFormat.format(n);
const percent = (decimal) => (decimal * 100).toFixed(2) + '%';

/** Create an element with optional text and class (text is never parsed as HTML). */
function el(tag, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

// ---------- state and inputs ----------
let params = paramsFromQuery(location.search);

/** Copy `params` into the input boxes. */
function writeInputs() {
  for (const field of FIELDS) {
    const input = document.querySelector(`[data-key="${field.path.join('.')}"]`);
    const value = getPath(params, field.path);
    if (field.type === 'bool') input.checked = value;
    else input.value = value;
  }
}

/** Read one input box into `params` (invalid text keeps the previous value). */
function readInput(input) {
  const field = FIELDS.find((f) => f.path.join('.') === input.dataset.key);
  const raw = field.type === 'bool' ? input.checked : input.value;
  const previous = getPath(params, field.path);
  const cleaned = field.type === 'bool' ? raw : cleanValue(field, raw, previous);
  setPath(params, field.path, cleaned);
}

for (const input of document.querySelectorAll('[data-key]')) {
  const handler = () => { readInput(input); render(); };
  input.addEventListener('input', handler);
  // After leaving a box, show the cleaned (clamped) value.
  input.addEventListener('change', () => { writeInputs(); });
}

// ---------- down payment % boxes ----------
// The URL and the model store the down payment in dollars. Each "%" box is a
// second view of that same number: typing a % sets dollars = price × % / 100,
// and any change to dollars or price refreshes the % shown.

/** Show each loan's down payment as a % of the price (skips the box being typed in). */
function writeDownPercents() {
  for (const id of ['A', 'B']) {
    const box = document.querySelector(`[data-down-pct="${id}"]`);
    if (document.activeElement === box) continue;
    const down = params[`loan${id}`].down;
    box.value = params.price > 0 ? +(down / params.price * 100).toFixed(2) : 0;
  }
}

for (const box of document.querySelectorAll('[data-down-pct]')) {
  const id = box.dataset.downPct;
  box.addEventListener('input', () => {
    const pct = Number(box.value);
    if (box.value === '' || !Number.isFinite(pct)) return;
    const clamped = Math.min(100, Math.max(0, pct));
    params[`loan${id}`].down = Math.round(params.price * clamped / 100);
    document.querySelector(`[data-key="loan${id}.down"]`).value = params[`loan${id}`].down;
    render();
  });
  box.addEventListener('change', writeDownPercents);
}

$('#copy-link').addEventListener('click', async () => {
  const button = $('#copy-link');
  try {
    await navigator.clipboard.writeText(location.href);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => { button.textContent = 'Copy link'; }, 1500);
});

// ---------- text sections ----------
function renderLoanSummaries(result) {
  for (const id of ['A', 'B']) {
    const loan = result[id];
    const badge = $(`[data-out="badge${id}"]`);
    badge.textContent = loan.isJumbo ? 'Jumbo' : 'Conforming';
    badge.classList.toggle('jumbo', loan.isJumbo);
    $(`[data-out="summary${id}"]`).textContent = `Loan ${money(loan.loanAmount)}, ${money(loan.monthlyPayment)} / month P&I`;
  }
}

function renderVerdict(model, result) {
  const a = result.A, b = result.B;
  const diff = a.final.netWorth - b.final.netWorth;
  const box = $('#verdict');
  box.classList.remove('win-a', 'win-b');
  if (Math.abs(diff) < 1) {
    $('#verdict-title').textContent = 'Both strategies end with the same net worth.';
  } else {
    const winner = diff > 0 ? a : b;
    box.classList.add(diff > 0 ? 'win-a' : 'win-b');
    $('#verdict-title').textContent = `${winner.label} ends ${money(Math.abs(diff))} ahead after ${model.horizonYears} years.`;
  }
  $('#verdict-detail').textContent =
    `Net worth: ${a.label} ${money(a.final.netWorth)} vs ${b.label} ${money(b.final.netWorth)}.`;

  const rate = breakEvenReturn(model);
  if (rate === null) {
    $('#verdict-breakeven').textContent = 'Break-even return: none between -10% and 30%, so the same strategy wins at every return in that range.';
  } else {
    const gapAbove = netWorthGap({ ...model, investReturn: Math.min(0.30, rate + 0.01) });
    const [high, low] = gapAbove > 0 ? [b, a] : [a, b];
    $('#verdict-breakeven').textContent =
      `${high.label} wins only if investments return more than ${percent(rate)} per year; below that, ${low.label} wins.`;
  }

  const crossovers = findCrossovers(result.series.A.netWorth, result.series.B.netWorth);
  $('#verdict-crossover').textContent = crossovers.length === 0
    ? 'Net worth lines never cross.'
    : crossovers.map((c) => `${c.winner === 'A' ? a.label : b.label} pulls ahead in year ${c.year}`).join('; ') + '.';
  return crossovers;
}

/**
 * Net worth for one yearly snapshot, written out as a sum you can follow.
 * Each line: [operator, label, dollars, isSubtotal]. The numbers add up top to bottom:
 * home value - selling costs - loan payoff = home equity;
 * investments - tax on gains = investments after tax; equity + investments = net worth.
 * @param {object} row A yearly snapshot from simulate() (rows[year]).
 * @param {object} model Model params (decimals), for the selling-cost and gains-tax rates.
 * @returns {[string, string, number, boolean][]}
 */
function netWorthBreakdown(row, model) {
  const sellingCosts = row.homeValue * model.sellingCost;
  const gainsTax = row.portfolio - row.portfolioAfterTax;
  const gains = Math.max(0, row.portfolio - row.contributions);
  const gainsTaxLabel = model.keepInvestments
    ? 'Tax on gains (investments kept, none due)'
    : `Tax on gains (${(model.gainsTax * 100).toFixed(1)}% of ${money(gains)})`;
  return [
    ['', `Home value (year ${row.year})`, row.homeValue, false],
    ['−', `Selling costs (${(model.sellingCost * 100).toFixed(1)}%)`, sellingCosts, false],
    ['−', 'Pay off remaining loan', row.balance, false],
    ['=', 'Home equity', row.homeEquity, true],
    ['', 'Investments (before tax)', row.portfolio, false],
    ['−', gainsTaxLabel, gainsTax, false],
    ['=', 'Investments after tax', row.portfolioAfterTax, true],
    ['=', 'Net worth (equity + investments)', row.netWorth, true],
  ];
}

function renderCards(model, result) {
  const cards = $('#cards');
  cards.replaceChildren();
  for (const id of ['A', 'B']) {
    const s = result[id];
    const f = s.final;
    const card = el('article', '', `card win-${id.toLowerCase()}`);
    card.append(el('h3', s.label), el('p', money(f.netWorth), 'big'));

    // The net worth math, line by line.
    const calc = el('dl', '', 'calc');
    for (const [op, label, value, isSubtotal] of netWorthBreakdown(f, model)) {
      const cls = isSubtotal ? 'subtotal' : '';
      calc.append(el('dt', `${op} ${label}`.trim(), cls), el('dd', money(value), cls));
    }

    // Other facts about the loan (already included in the math above).
    const facts = el('dl', '', 'facts');
    const rows = [
      ['Total interest paid', money(f.cumInterest)],
      ['Total principal paid', money(f.cumPrincipal)],
      ['Tax benefit from interest (already in investments)', money(f.cumBenefit)],
      ['Money put into investments', money(f.contributions)],
    ];
    for (const [term, value] of rows) facts.append(el('dt', term), el('dd', value));
    card.append(calc, facts);
    cards.append(card);
  }
  const cashA = result.A.final.cashSpent, cashB = result.B.final.cashSpent;
  $('#sanity').textContent =
    `Sanity check, total cash spent: ${result.A.label} ${money(cashA)}, ${result.B.label} ${money(cashB)} (${Math.abs(cashA - cashB) < 0.5 ? 'equal' : 'NOT equal'}). ` +
    `Portfolio before tax: ${money(result.A.final.portfolio)} vs ${money(result.B.final.portfolio)}; ` +
    `total invested (cost basis): ${money(result.A.final.contributions)} vs ${money(result.B.final.contributions)}.`;
}

function renderTable(result) {
  const table = $('#year-table');
  table.replaceChildren();
  const head = el('tr');
  const a = result.A.label, b = result.B.label;
  ['Year', `Net worth ${a}`, `Net worth ${b}`, 'B minus A', `Balance ${a}`, `Balance ${b}`,
    `Portfolio ${a}`, `Portfolio ${b}`, `Interest in year ${a}`, `Interest in year ${b}`]
    .forEach((name) => head.append(el('th', name)));
  const thead = el('thead');
  thead.append(head);
  table.append(thead);
  const body = el('tbody');
  result.A.rows.forEach((rowA, i) => {
    const rowB = result.B.rows[i];
    const tr = el('tr');
    [i, ...[rowA.netWorth, rowB.netWorth, rowB.netWorth - rowA.netWorth, rowA.balance, rowB.balance,
      rowA.portfolio, rowB.portfolio, rowA.yearInterest, rowB.yearInterest].map(money)]
      .forEach((text) => tr.append(el('td', String(text))));
    body.append(tr);
  });
  table.append(body);
}

// ---------- charts ----------
const charts = [];

/** Read a CSS color variable so charts follow the light/dark theme. */
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Draws a dashed vertical line and label at each crossover year. */
function crossoverPlugin(crossovers, labels) {
  return {
    id: 'crossovers',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      ctx.save();
      ctx.strokeStyle = cssVar('--ink-2');
      ctx.fillStyle = cssVar('--ink');
      ctx.setLineDash([4, 4]);
      ctx.font = '12px system-ui, sans-serif';
      for (const c of crossovers) {
        // Category axis: the label index equals the year.
        const x = scales.x.getPixelForValue(c.year);
        ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
        ctx.textAlign = x > chartArea.right - 120 ? 'right' : 'left';
        ctx.fillText(`${labels[c.winner]} pulls ahead, year ${c.year}`, x + (ctx.textAlign === 'left' ? 4 : -4), chartArea.top + 12);
      }
      ctx.restore();
    },
  };
}

/**
 * Build one Chart.js chart.
 * @param {string} canvasId Canvas element id.
 * @param {'line'|'bar'} type Chart type.
 * @param {number[]} years X labels (0..horizon or 1..horizon).
 * @param {object[]} datasets Chart.js datasets.
 * @param {object} [extra] Extra options: stacked (bool), plugins (array).
 */
function makeChart(canvasId, type, years, datasets, { stacked = false, plugins = [], yMax, hideLegend = false, afterLabel } = {}) {
  const ink = cssVar('--ink-2'), grid = cssVar('--grid');
  const chart = new Chart(document.getElementById(canvasId), {
    type,
    data: { labels: years, datasets },
    plugins,
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked, title: { display: true, text: 'Year', color: ink }, ticks: { color: ink, maxTicksLimit: 10 }, grid: { display: false } },
        y: { stacked, max: yMax, ticks: { color: ink, callback: (v) => compactFormat.format(v) }, grid: { color: grid } },
      },
      plugins: {
        legend: { display: !hideLegend, labels: { color: cssVar('--ink'), usePointStyle: true, boxWidth: 8 } },
        tooltip: {
          callbacks: {
            title: (items) => `Year ${items[0].label}`,
            label: (item) => `${item.dataset.label}: ${money(item.parsed.y)}`,
            // Optional extra lines under each value (used for the net worth breakdown).
            ...(afterLabel && { afterLabel: (item) => afterLabel(item.datasetIndex, item.dataIndex) }),
          },
        },
      },
    },
  });
  charts.push(chart);
}

/** A 2px line with no point markers except on hover. */
function lineSet(label, data, color) {
  return { label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0 };
}

/** Yearly stacked bars: principal in the loan color, interest in gray. */
function splitSets(series, loanColor) {
  const rest = (arr) => arr.slice(1); // year 0 has no payments
  return [
    { label: 'Principal', data: rest(series.yearPrincipal), backgroundColor: loanColor, borderRadius: 0 },
    { label: 'Interest', data: rest(series.yearInterest), backgroundColor: cssVar('--neutral'), borderRadius: 0 },
  ];
}

/** Yearly stacked bars: money put in (gray) and growth on top (loan color). */
function portfolioSets(series, loanColor) {
  const growth = series.portfolio.map((value, i) => Math.max(0, value - series.contributions[i]));
  return [
    { label: 'Money put in', data: series.contributions, backgroundColor: cssVar('--neutral'), borderRadius: 0 },
    { label: 'Growth', data: growth, backgroundColor: loanColor, borderRadius: 0 },
  ];
}

function renderCharts(result, crossovers, model) {
  charts.splice(0).forEach((c) => c.destroy());
  const { series } = result;
  const colorA = cssVar('--a'), colorB = cssVar('--b');
  const a = result.A.label, b = result.B.label;
  const both = (key) => [lineSet(a, series.A[key], colorA), lineSet(b, series.B[key], colorB)];
  const yearsFrom1 = series.years.slice(1);

  // Hovering a year shows how each net worth is built (same math as the result cards).
  const breakdownLines = (datasetIndex, year) => {
    const row = (datasetIndex === 0 ? result.A : result.B).rows[year];
    return netWorthBreakdown(row, model).slice(0, -1)
      .map(([op, label, value]) => `   ${op || '+'} ${label}: ${money(value)}`);
  };
  makeChart('chart-networth', 'line', series.years, both('netWorth'),
    { plugins: [crossoverPlugin(crossovers, { A: a, B: b })], afterLabel: breakdownLines });

  // Net worth gap per year: above zero means B is ahead, below zero means A is ahead.
  // Bars take the color of whoever leads that year.
  const gap = series.B.netWorth.map((nb, i) => nb - series.A.netWorth[i]);
  $('#cap-gap').textContent = `Net worth difference, ${b} minus ${a} (above 0 = ${b} ahead)`;
  makeChart('chart-gap', 'bar', series.years, [{
    label: `${b} minus ${a}`, data: gap, borderRadius: 0,
    backgroundColor: gap.map((d) => (d >= 0 ? colorB : colorA)),
  }], { plugins: [crossoverPlugin(crossovers, { A: a, B: b })], hideLegend: true });

  // Both split charts share one y-axis maximum so the bars are comparable.
  const yearlyTotal = (s) => Math.max(...s.yearPrincipal.map((p, i) => p + s.yearInterest[i]));
  const sharedMax = Math.max(yearlyTotal(series.A), yearlyTotal(series.B)) * 1.05;
  $('#cap-split-a').textContent = `Yearly payment split, ${a}`;
  $('#cap-split-b').textContent = `Yearly payment split, ${b}`;
  makeChart('chart-split-a', 'bar', yearsFrom1, splitSets(series.A, colorA), { stacked: true, yMax: sharedMax });
  makeChart('chart-split-b', 'bar', yearsFrom1, splitSets(series.B, colorB), { stacked: true, yMax: sharedMax });

  // Portfolio = money put in (cost basis) + growth on top (compounding). Shared y-axis.
  const portfolioMax = Math.max(...series.A.portfolio, ...series.B.portfolio, 1) * 1.05;
  $('#cap-port-a').textContent = `Investments, ${a}: money put in vs growth`;
  $('#cap-port-b').textContent = `Investments, ${b}: money put in vs growth`;
  makeChart('chart-port-a', 'bar', series.years, portfolioSets(series.A, colorA), { stacked: true, yMax: portfolioMax });
  makeChart('chart-port-b', 'bar', series.years, portfolioSets(series.B, colorB), { stacked: true, yMax: portfolioMax });

  makeChart('chart-balance', 'line', series.years, both('balance'));

  renderChartTotals(result);
}

/**
 * One line of totals under each chart title, so the key numbers don't need hovering.
 * Totals are "at the horizon" (the sell or stop year), same as the result cards.
 */
function renderChartTotals(result) {
  const A = result.A, B = result.B;
  const set = (id, parts) => { $(id).textContent = parts.join('  ·  '); };
  const lastYear = A.rows.length - 1;

  set('#tot-networth', [`${A.label}: ${money(A.final.netWorth)}`, `${B.label}: ${money(B.final.netWorth)}`]);

  const gap = B.final.netWorth - A.final.netWorth;
  const leader = gap >= 0 ? B.label : A.label;
  set('#tot-gap', [`Year ${lastYear}: ${leader} ahead by ${money(Math.abs(gap))}`]);

  for (const [id, s] of [['a', A], ['b', B]]) {
    const paid = s.final.cumPrincipal + s.final.cumInterest;
    const interestShare = paid > 0 ? Math.round((s.final.cumInterest / paid) * 100) : 0;
    set(`#tot-split-${id}`, [
      `Principal ${money(s.final.cumPrincipal)}`,
      `Interest ${money(s.final.cumInterest)}`,
      `Total paid ${money(paid)} (${interestShare}% interest)`,
    ]);
    const growth = Math.max(0, s.final.portfolio - s.final.contributions);
    set(`#tot-port-${id}`, [
      `Put in ${money(s.final.contributions)}`,
      `Growth ${money(growth)}`,
      `Total ${money(s.final.portfolio)} (${money(s.final.portfolioAfterTax)} after tax)`,
    ]);
  }

  // Payoff year = first year the balance hits zero (if it does before the horizon).
  const payoff = (s) => {
    const year = s.rows.findIndex((row, i) => i > 0 && row.balance === 0);
    return year === -1 ? `${money(s.final.balance)} left at year ${lastYear}` : `paid off in year ${year}`;
  };
  set('#tot-balance', [`${A.label}: ${payoff(A)}`, `${B.label}: ${payoff(B)}`]);
}

// ---------- main render ----------
function render() {
  writeDownPercents();
  history.replaceState(null, '', '?' + paramsToQuery(params));
  const model = toModelParams(params);
  const result = simulate(model);
  renderLoanSummaries(result);
  const crossovers = renderVerdict(model, result);
  renderCards(model, result);
  renderTable(result);
  renderCharts(result, crossovers, model);
  lastResult = { result, crossovers, model };
}

let lastResult = null;
// Re-draw charts when the OS theme changes so colors match.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (lastResult) renderCharts(lastResult.result, lastResult.crossovers, lastResult.model);
});

writeInputs();
render();
