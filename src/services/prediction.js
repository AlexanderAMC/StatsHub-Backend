// RF-37: probabilidad de victoria. Se consulta el microservicio de Machine Learning en Python
// (ml-service/, regresión de Poisson con scikit-learn). Si no está disponible, se usa el mismo
// modelo de Poisson implementado aquí, para que la plataforma nunca se quede sin predicción.
const MAX_GOALS = 10;
const HOME_ADVANTAGE = 1.1;
const SMOOTHING = 2;

function poisson(k, lambda) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i += 1) p *= lambda / i;
  return p;
}

function outcome(lambdaHome, lambdaAway) {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let h = 0; h <= MAX_GOALS; h += 1) {
    for (let a = 0; a <= MAX_GOALS; a += 1) {
      const p = poisson(h, lambdaHome) * poisson(a, lambdaAway);
      if (h > a) home += p;
      else if (h < a) away += p;
      else draw += p;
    }
  }
  const total = home + draw + away;
  return { local: home / total, empate: draw / total, visita: away / total };
}

// Fuerza de ataque y defensa de cada equipo relativa al promedio de la liga, con suavizado
// para equipos con pocos partidos.
function localPoisson(history, fixtures) {
  const table = new Map();
  const row = (id) => {
    if (!table.has(id)) table.set(id, { gf: 0, gc: 0, pj: 0 });
    return table.get(id);
  };
  let goals = 0;
  for (const m of history) {
    const h = row(m.local);
    const a = row(m.visita);
    h.gf += m.goles_local; h.gc += m.goles_visita; h.pj += 1;
    a.gf += m.goles_visita; a.gc += m.goles_local; a.pj += 1;
    goals += m.goles_local + m.goles_visita;
  }
  const avg = history.length ? goals / (2 * history.length) : 1.3;
  const strength = (id) => {
    const r = table.get(id) ?? { gf: 0, gc: 0, pj: 0 };
    return {
      attack: (r.gf + SMOOTHING * avg) / (r.pj + SMOOTHING) / avg,
      defense: (r.gc + SMOOTHING * avg) / (r.pj + SMOOTHING) / avg,
    };
  };
  return fixtures.map((f) => {
    const h = strength(f.local);
    const a = strength(f.visita);
    const lambdaHome = avg * h.attack * a.defense * HOME_ADVANTAGE;
    const lambdaAway = avg * a.attack * h.defense;
    return {
      partido_id: f.id,
      ...outcome(lambdaHome, lambdaAway),
      goles_esperados_local: lambdaHome,
      goles_esperados_visita: lambdaAway,
      modelo: 'poisson-node',
    };
  });
}

async function predict(history, fixtures) {
  if (fixtures.length === 0) return [];
  const url = process.env.ML_SERVICE_URL;
  if (url) {
    try {
      const response = await fetch(`${url.replace(/\/$/, '')}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history, fixtures }),
        signal: AbortSignal.timeout(Number(process.env.ML_TIMEOUT_MS || 3000)),
      });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data.predictions)) return data.predictions;
      }
      console.warn(`Servicio de ML respondió ${response.status}; se usa el modelo local`);
    } catch (error) {
      console.warn(`Servicio de ML no disponible (${error.message}); se usa el modelo local`);
    }
  }
  return localPoisson(history, fixtures);
}

module.exports = { predict, localPoisson, outcome };
