const { badRequest } = require('./errors');

// Validadores de entrada comunes para los controladores. Lanzan AppError 400 (ver app.js).

function positiveInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw badRequest(`${field} debe ser un entero positivo`);
  return n;
}

function optionalPositiveInt(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return positiveInt(value, field);
}

function text(value, field, { max = 200, required = true } = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) throw badRequest(`${field} es obligatorio`);
    return null;
  }
  if (typeof value !== 'string') throw badRequest(`${field} debe ser texto`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw badRequest(`${field} no puede superar ${max} caracteres`);
  return trimmed;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function date(value, field, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} es obligatoria`);
    return null;
  }
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw badRequest(`${field} debe tener el formato AAAA-MM-DD`);
  }
  return value;
}

function time(value, field) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) throw badRequest(`${field} debe tener el formato HH:MM`);
  return value;
}

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw badRequest(`${field} inválido`);
  return value;
}

module.exports = { positiveInt, optionalPositiveInt, text, date, time, oneOf };
