const crypto = require('node:crypto');

// Cliente mínimo de la API de Flow (https://www.flow.cl/docs/api.html).
// RNF-10: StatsHub nunca recibe ni guarda datos de tarjetas; el pago ocurre en Flow.
// Sandbox: https://sandbox.flow.cl/api   Producción: https://www.flow.cl/api
const FLOW_STATUS = Object.freeze({ PENDIENTE: 1, PAGADO: 2, RECHAZADO: 3, ANULADO: 4 });

function config() {
  return {
    apiUrl: (process.env.FLOW_API_URL || 'https://sandbox.flow.cl/api').replace(/\/$/, ''),
    apiKey: process.env.FLOW_API_KEY,
    secretKey: process.env.FLOW_SECRET_KEY,
  };
}

const isConfigured = () => Boolean(process.env.FLOW_API_KEY && process.env.FLOW_SECRET_KEY);

// Firma de Flow: parámetros ordenados por nombre, concatenados como nombre+valor,
// firmados con HMAC-SHA256 usando la secretKey.
function sign(params, secretKey) {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join('');
  return crypto.createHmac('sha256', secretKey).update(toSign).digest('hex');
}

async function call(method, path, params) {
  const { apiUrl, apiKey, secretKey } = config();
  const all = { ...params, apiKey };
  const body = new URLSearchParams({ ...all, s: sign(all, secretKey) });

  const url = method === 'GET' ? `${apiUrl}${path}?${body}` : `${apiUrl}${path}`;
  const response = await fetch(url, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
    body: method === 'POST' ? body : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `Flow respondió ${response.status}`);
    error.flow = data;
    throw error;
  }
  return data;
}

// Crea la orden de pago. Devuelve { url, token, flowOrder }; el usuario se redirige a `${url}?token=${token}`.
const createPayment = (params) => call('POST', '/payment/create', params);

// Consulta el estado real del pago (nunca confiar solo en lo que llega al webhook).
const getStatus = (token) => call('GET', '/payment/getStatus', { token });

module.exports = { FLOW_STATUS, isConfigured, sign, createPayment, getStatus };
