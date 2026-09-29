/**
 * params.js - default inputs, URL <-> params conversion, and UI -> model conversion.
 *
 * UNITS: "UI params" (this file's defaults, the URL, the input boxes) use PERCENT
 * numbers (7 means 7%). The calculation library (mortgage.js) uses DECIMALS
 * (0.07). `toModelParams` is the single place where that conversion happens.
 */


/** Default inputs in UI units (percent as plain numbers, dollars as dollars). */
export const DEFAULTS = {
  price: 1000000,
  appreciation: 3,
  horizon: 30,
  investReturn: 7,
  gainsTax: 23.8,
  keepInvestments: false,
  sellingCost: 7,
  deduct: true,
  marginalRate: 32,
  standardDeduction: 32200,
  otherItemized: 10000,
  loanCap: 750000,
  conformingLimit: 832750,
  loanA: { label: 'Loan A', down: 400000, term: 15, rate: 6 },
  loanB: { label: 'Loan B', down: 100000, term: 30, rate: 6.75 },
};

/**
 * One row per URL key: which field it sets, its type and allowed range.
 * `path` is [field] or [loan, field].
 */
export const FIELDS = [
  { key: 'p',   path: ['price'],             type: 'number', min: 10000, max: 100000000 },
  { key: 'g',   path: ['appreciation'],      type: 'number', min: -10,   max: 20 },
  { key: 'y',   path: ['horizon'],           type: 'int',    min: 1,     max: 40 },
  { key: 'r',   path: ['investReturn'],      type: 'number', min: -20,   max: 40 },
  { key: 'gt',  path: ['gainsTax'],          type: 'number', min: 0,     max: 60 },
  { key: 'ki',  path: ['keepInvestments'],   type: 'bool' },
  { key: 'sc',  path: ['sellingCost'],       type: 'number', min: 0,     max: 30 },
  { key: 'ded', path: ['deduct'],            type: 'bool' },
  { key: 'mt',  path: ['marginalRate'],      type: 'number', min: 0,     max: 60 },
  { key: 'sd',  path: ['standardDeduction'], type: 'number', min: 0,     max: 10000000 },
  { key: 'oi',  path: ['otherItemized'],     type: 'number', min: 0,     max: 10000000 },
  { key: 'cap', path: ['loanCap'],           type: 'number', min: 0,     max: 100000000 },
  { key: 'cl',  path: ['conformingLimit'],   type: 'number', min: 0,     max: 100000000 },
  { key: 'al',  path: ['loanA', 'label'],    type: 'text' },
  { key: 'ad',  path: ['loanA', 'down'],     type: 'number', min: 0,     max: 100000000 },
  { key: 'at',  path: ['loanA', 'term'],     type: 'int',    min: 1,     max: 40 },
  { key: 'ar',  path: ['loanA', 'rate'],     type: 'number', min: 0,     max: 25 },
  { key: 'bl',  path: ['loanB', 'label'],    type: 'text' },
  { key: 'bd',  path: ['loanB', 'down'],     type: 'number', min: 0,     max: 100000000 },
  { key: 'bt',  path: ['loanB', 'term'],     type: 'int',    min: 1,     max: 40 },
  { key: 'br',  path: ['loanB', 'rate'],     type: 'number', min: 0,     max: 25 },
];

const MAX_LABEL_LENGTH = 30;

/**
 * Read a value at a path, e.g. ['loanA','down'].
 * @param {object} params UI params.
 * @param {string[]} path Field path.
 * @returns {*} The value.
 * @example
 * getPath(DEFAULTS, ['loanA', 'down']); // 400000
 */
export function getPath(params, path) {
  return path.reduce((obj, name) => obj[name], params);
}

/**
 * Write a value at a path (mutates `params`).
 * @param {object} params UI params.
 * @param {string[]} path Field path.
 * @param {*} value New value.
 * @returns {void}
 * @example
 * const p = structuredClone(DEFAULTS); setPath(p, ['loanA', 'down'], 1); // p.loanA.down === 1
 */
export function setPath(params, path, value) {
  const parent = getPath(params, path.slice(0, -1));
  parent[path[path.length - 1]] = value;
}

/**
 * Turn raw text (or a value) into a valid value for a field, or the fallback.
 * @param {object} field An entry of FIELDS.
 * @param {*} raw Raw input (string from the URL or an input box).
 * @param {*} fallback Value used when `raw` is unusable.
 * @returns {*} A clamped number, boolean, or trimmed label.
 * @example
 * cleanValue({type: 'number', min: 0, max: 60}, '99', 32); // 60
 */
export function cleanValue(field, raw, fallback) {
  switch (field.type) {
    case 'bool':
      return raw === true || raw === '1' ? true : raw === false || raw === '0' ? false : fallback;
    case 'text': {
      const text = String(raw).trim().slice(0, MAX_LABEL_LENGTH);
      return text === '' ? fallback : text;
    }
    default: { // 'number' and 'int'
      if (raw === '' || raw === null) return fallback;
      let number = Number(raw);
      if (!Number.isFinite(number)) return fallback;
      if (field.type === 'int') number = Math.round(number);
      return Math.min(field.max, Math.max(field.min, number));
    }
  }
}

/**
 * Build UI params from a URL query string. Missing, invalid or unknown keys are
 * ignored (defaults are used); numbers are clamped to their allowed range.
 * @param {string} search Query string, e.g. "?p=1200000&y=20".
 * @returns {object} Complete UI params.
 * @example
 * paramsFromQuery('?p=1200000&y=99&zzz=1').horizon; // 40 (clamped)
 */
export function paramsFromQuery(search) {
  const query = new URLSearchParams(search);
  const params = structuredClone(DEFAULTS);
  for (const field of FIELDS) {
    if (!query.has(field.key)) continue;
    setPath(params, field.path, cleanValue(field, query.get(field.key), getPath(params, field.path)));
  }
  return params;
}

/**
 * Convert UI params to a query string (all keys, no leading "?").
 * @param {object} params UI params.
 * @returns {string} e.g. "p=1000000&g=3&...".
 * @example
 * paramsToQuery(DEFAULTS).startsWith('p=1000000&g=3'); // true
 */
export function paramsToQuery(params) {
  const query = new URLSearchParams();
  for (const field of FIELDS) {
    const value = getPath(params, field.path);
    query.set(field.key, field.type === 'bool' ? (value ? '1' : '0') : String(value));
  }
  return query.toString();
}

/**
 * Convert UI params (percent) into model params (decimals) for mortgage.js.
 * Down payments are capped at the house price.
 * @param {object} ui UI params.
 * @returns {object} Model params for simulate().
 * @example
 * toModelParams(DEFAULTS).investReturn; // 0.07
 */
export function toModelParams(ui) {
  const toLoan = (loan) => ({
    label: loan.label,
    down: Math.min(loan.down, ui.price),
    termYears: loan.term,
    rate: loan.rate / 100,
  });
  return {
    price: ui.price,
    appreciation: ui.appreciation / 100,
    horizonYears: ui.horizon,
    investReturn: ui.investReturn / 100,
    gainsTax: ui.gainsTax / 100,
    keepInvestments: ui.keepInvestments,
    sellingCost: ui.sellingCost / 100,
    deductInterest: ui.deduct,
    marginalRate: ui.marginalRate / 100,
    standardDeduction: ui.standardDeduction,
    otherItemized: ui.otherItemized,
    loanCap: ui.loanCap,
    conformingLimit: ui.conformingLimit,
    loanA: toLoan(ui.loanA),
    loanB: toLoan(ui.loanB),
  };
}

/** Model params for the default scenario (handy for tests and doc examples). */
export const defaultModelParams = toModelParams(DEFAULTS);
