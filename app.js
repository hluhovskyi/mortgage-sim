// app.js - wires the inputs, the calculation library and the charts together.
// Flow: read inputs -> params -> simulate -> render text, cards, table, charts.

import { simulate, findCrossovers, breakEvenReturn, netWorthGap } from './lib/mortgage.js';
import {
  FIELDS, paramsFromQuery, paramsToQuery, toModelParams, getPath, setPath, cleanValue,
} from './lib/params.js';

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

function renderCards(model, result) {
  const cards = $('#cards');
  cards.replaceChildren();
  for (const id of ['A', 'B']) {
    const s = result[id];
    const f = s.final;
    const card = el('article', '', `card win-${id.toLowerCase()}`);
    card.append(el('h3', s.label), el('p', money(f.netWorth), 'big'));
    const list = el('dl');
    const rows = [
      ['Net worth', money(f.netWorth)],
      ['Home equity (net of selling costs)', money(f.homeEquity)],
      ['Portfolio after tax', money(f.portfolioAfterTax)],
      ['Total interest paid', money(f.cumInterest)],
      ['Total principal paid', money(f.cumPrincipal)],
      ['Tax benefit from interest', money(f.cumBenefit)],
      ['Remaining loan balance', money(f.balance)],
    ];
    for (const [term, value] of rows) list.append(el('dt', term), el('dd', value));
    card.append(list);
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
function makeChart(canvasId, type, years, datasets, { stacked = false, plugins = [], yMax } = {}) {
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
        legend: { labels: { color: cssVar('--ink'), usePointStyle: true, boxWidth: 8 } },
        tooltip: {
          callbacks: {
            title: (items) => `Year ${items[0].label}`,
            label: (item) => `${item.dataset.label}: ${money(item.parsed.y)}`,
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

function renderCharts(result, crossovers) {
  charts.splice(0).forEach((c) => c.destroy());
  const { series } = result;
  const colorA = cssVar('--a'), colorB = cssVar('--b');
  const a = result.A.label, b = result.B.label;
  const both = (key) => [lineSet(a, series.A[key], colorA), lineSet(b, series.B[key], colorB)];
  const yearsFrom1 = series.years.slice(1);

  makeChart('chart-networth', 'line', series.years, both('netWorth'),
    { plugins: [crossoverPlugin(crossovers, { A: a, B: b })] });

  // Net worth gap per year: above zero means B is ahead, below zero means A is ahead.
  // Bars take the color of whoever leads that year.
  const gap = series.B.netWorth.map((nb, i) => nb - series.A.netWorth[i]);
  $('#cap-gap').textContent = `Net worth difference, ${b} minus ${a} (above 0 = ${b} ahead)`;
  makeChart('chart-gap', 'bar', series.years, [{
    label: `${b} minus ${a}`, data: gap, borderRadius: 0,
    backgroundColor: gap.map((d) => (d >= 0 ? colorB : colorA)),
  }], { plugins: [crossoverPlugin(crossovers, { A: a, B: b })] });

  // Both split charts share one y-axis maximum so the bars are comparable.
  const yearlyTotal = (s) => Math.max(...s.yearPrincipal.map((p, i) => p + s.yearInterest[i]));
  const sharedMax = Math.max(yearlyTotal(series.A), yearlyTotal(series.B)) * 1.05;
  $('#cap-split-a').textContent = `Yearly payment split, ${a}`;
  $('#cap-split-b').textContent = `Yearly payment split, ${b}`;
  makeChart('chart-split-a', 'bar', yearsFrom1, splitSets(series.A, colorA), { stacked: true, yMax: sharedMax });
  makeChart('chart-split-b', 'bar', yearsFrom1, splitSets(series.B, colorB), { stacked: true, yMax: sharedMax });

  makeChart('chart-balance', 'line', series.years, both('balance'));
  makeChart('chart-portfolio', 'line', series.years, both('portfolio'));
}

// ---------- main render ----------
function render() {
  history.replaceState(null, '', '?' + paramsToQuery(params));
  const model = toModelParams(params);
  const result = simulate(model);
  renderLoanSummaries(result);
  const crossovers = renderVerdict(model, result);
  renderCards(model, result);
  renderTable(result);
  renderCharts(result, crossovers);
  lastResult = { result, crossovers };
}

let lastResult = null;
// Re-draw charts when the OS theme changes so colors match.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (lastResult) renderCharts(lastResult.result, lastResult.crossovers);
});

writeInputs();
render();
