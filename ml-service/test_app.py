"""Pruebas del servicio de ML:  python -m unittest test_app.py"""
import unittest

from app import outcome_probabilities, predict


class PredictTests(unittest.TestCase):
    def setUp(self):
        # El equipo 1 gana siempre con holgura; 2 y 3 empatan entre sí.
        self.history = [
            {"local": 1, "visita": 2, "goles_local": 4, "goles_visita": 0},
            {"local": 3, "visita": 1, "goles_local": 0, "goles_visita": 3},
            {"local": 2, "visita": 3, "goles_local": 1, "goles_visita": 1},
            {"local": 1, "visita": 3, "goles_local": 3, "goles_visita": 1},
            {"local": 2, "visita": 1, "goles_local": 0, "goles_visita": 2},
        ]

    def test_probabilidades_suman_uno(self):
        result = predict(self.history, [{"id": 9, "local": 2, "visita": 3}])
        p = result[0]
        self.assertAlmostEqual(p["local"] + p["empate"] + p["visita"], 1.0, places=3)
        self.assertEqual(p["partido_id"], 9)
        self.assertEqual(p["modelo"], "poisson-sklearn")

    def test_el_equipo_fuerte_es_favorito(self):
        result = predict(self.history, [{"id": 1, "local": 1, "visita": 2}, {"id": 2, "local": 2, "visita": 1}])
        self.assertGreater(result[0]["local"], result[0]["visita"])
        self.assertGreater(result[1]["visita"], result[1]["local"])
        self.assertGreater(result[0]["goles_esperados_local"], result[0]["goles_esperados_visita"])

    def test_equipo_sin_historial_no_falla(self):
        result = predict(self.history, [{"id": 5, "local": 99, "visita": 1}])
        self.assertEqual(len(result), 1)

    def test_sin_historial_devuelve_vacio(self):
        self.assertEqual(predict([], [{"id": 1, "local": 1, "visita": 2}]), [])

    def test_goles_negativos_son_invalidos(self):
        with self.assertRaises(ValueError):
            predict([{"local": 1, "visita": 2, "goles_local": -1, "goles_visita": 0}], [{"id": 1, "local": 1, "visita": 2}])

    def test_outcome_simetrico(self):
        home, draw, away = outcome_probabilities(1.2, 1.2)
        self.assertAlmostEqual(home, away, places=6)
        self.assertGreater(draw, 0)


if __name__ == "__main__":
    unittest.main()
