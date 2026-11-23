"""Servicio de Machine Learning de StatsHub Deportivo (RF-37).

Entrena una regresión de Poisson (scikit-learn) con el historial de partidos y estima los
goles esperados de cada equipo; con eso calcula la probabilidad de victoria local, empate y
victoria visitante.

Modelo: log(goles) = intercepto + ataque[equipo] + defensa[rival] + localía
(equivalente al modelo clásico de Maher / Dixon-Coles sin corrección de marcadores bajos).

API (JSON):
  GET  /health   -> {"status": "ok"}
  POST /predict  -> body {"history": [{"local", "visita", "goles_local", "goles_visita"}],
                          "fixtures": [{"id", "local", "visita"}]}
                    respuesta {"predictions": [{"partido_id", "local", "empate", "visita",
                               "goles_esperados_local", "goles_esperados_visita", "modelo"}]}

Uso:  python app.py   (variables: ML_HOST=127.0.0.1, ML_PORT=8000)
"""
import json
import math
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from sklearn.linear_model import PoissonRegressor

MAX_GOALS = 10
MAX_BODY_BYTES = 2 * 1024 * 1024
# Regularización L2: evita estimaciones extremas cuando un equipo tiene pocos partidos.
ALPHA = float(os.environ.get("ML_ALPHA", "0.3"))


def poisson_pmf(k, lam):
    return math.exp(-lam) * lam**k / math.factorial(k)


def outcome_probabilities(lam_home, lam_away):
    home = draw = away = 0.0
    for h in range(MAX_GOALS + 1):
        p_h = poisson_pmf(h, lam_home)
        for a in range(MAX_GOALS + 1):
            p = p_h * poisson_pmf(a, lam_away)
            if h > a:
                home += p
            elif h < a:
                away += p
            else:
                draw += p
    total = home + draw + away
    return home / total, draw / total, away / total


def _validate_history(history):
    rows = []
    for m in history:
        local, visita = m["local"], m["visita"]
        gl, gv = int(m["goles_local"]), int(m["goles_visita"])
        if gl < 0 or gv < 0:
            raise ValueError("Los goles no pueden ser negativos")
        rows.append((local, visita, gl, gv))
    return rows


def predict(history, fixtures):
    matches = _validate_history(history)
    if not matches or not fixtures:
        return []

    teams = sorted({t for m in matches for t in m[:2]} | {t for f in fixtures for t in (f["local"], f["visita"])}, key=str)
    index = {team: i for i, team in enumerate(teams)}
    n = len(teams)

    def features(attacker, defender, is_home):
        row = np.zeros(2 * n + 1)
        row[index[attacker]] = 1.0          # ataque del equipo que anota
        row[n + index[defender]] = 1.0      # defensa del rival
        row[2 * n] = 1.0 if is_home else 0.0  # ventaja de localía
        return row

    X, y = [], []
    for local, visita, gl, gv in matches:
        X.append(features(local, visita, True))
        y.append(gl)
        X.append(features(visita, local, False))
        y.append(gv)

    model = PoissonRegressor(alpha=ALPHA, max_iter=1000)
    model.fit(np.array(X), np.array(y, dtype=float))

    predictions = []
    for f in fixtures:
        lam_home, lam_away = model.predict(np.array([
            features(f["local"], f["visita"], True),
            features(f["visita"], f["local"], False),
        ]))
        p_home, p_draw, p_away = outcome_probabilities(float(lam_home), float(lam_away))
        predictions.append({
            "partido_id": f["id"],
            "local": round(p_home, 4),
            "empate": round(p_draw, 4),
            "visita": round(p_away, 4),
            "goles_esperados_local": round(float(lam_home), 3),
            "goles_esperados_visita": round(float(lam_away), 3),
            "modelo": "poisson-sklearn",
        })
    return predictions


class Handler(BaseHTTPRequestHandler):
    server_version = "StatsHubML/1.0"

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"status": "ok"})
        return self._send(404, {"error": "No encontrado"})

    def do_POST(self):
        if self.path != "/predict":
            return self._send(404, {"error": "No encontrado"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            return self._send(413, {"error": "Cuerpo vacío o demasiado grande"})
        try:
            data = json.loads(self.rfile.read(length))
            result = predict(data.get("history", []), data.get("fixtures", []))
        except (ValueError, KeyError, TypeError) as error:
            return self._send(400, {"error": f"Datos inválidos: {error}"})
        return self._send(200, {"predictions": result})

    def log_message(self, fmt, *args):  # registro compacto
        print(f"[ml-service] {self.address_string()} {fmt % args}")


def main():
    host = os.environ.get("ML_HOST", "127.0.0.1")
    port = int(os.environ.get("ML_PORT", "8000"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Servicio de ML escuchando en http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
