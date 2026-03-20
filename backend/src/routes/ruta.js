const express = require('express');
const router  = express.Router();
const pool    = require('../db');

// ── Dijkstra ────────────────────────────────────────────────
function dijkstra(grafo, inicio, fin) {
  const costos     = {};
  const previo     = {};
  const visitados  = new Set();
  const cola       = new Map();

  costos[inicio] = { transbordos: 0, distancia: 0 };
  cola.set(inicio, 0);

  const costo_total = (nodo) => {
    const c = costos[nodo];
    return c.transbordos * 100000 + c.distancia;
  };

  while (cola.size > 0) {
    const actual = [...cola.entries()].reduce((a, b) => a[1] <= b[1] ? a : b)[0];
    cola.delete(actual);

    if (actual === fin) break;
    if (visitados.has(actual)) continue;
    visitados.add(actual);

    const vecinos = grafo[actual] || [];
    for (const { nodo, peso, id_ruta, direccion } of vecinos) {
      if (visitados.has(nodo)) continue;

      const ruta_actual   = previo[actual]?.id_ruta || null;
      const es_transbordo = ruta_actual && id_ruta && ruta_actual !== id_ruta ? 1 : 0;

      const nuevo_costo = {
        transbordos: (costos[actual]?.transbordos || 0) + es_transbordo,
        distancia:   (costos[actual]?.distancia   || 0) + peso,
      };

      const nuevo_total = nuevo_costo.transbordos * 100000 + nuevo_costo.distancia;
      const actual_total = costos[nodo] ? costo_total(nodo) : Infinity;

      if (nuevo_total < actual_total) {
        costos[nodo] = nuevo_costo;
        previo[nodo] = { desde: actual, id_ruta, direccion };
        cola.set(nodo, nuevo_total);
      }
    }
  }

  if (!costos[fin]) return null;

  const camino = [];
  let cursor   = fin;
  while (cursor !== undefined) {
    camino.unshift({ id_parada: cursor, ...previo[cursor] });
    cursor = previo[cursor]?.desde;
  }

  return {
    camino,
    distancia_total_m: costos[fin].distancia,
    total_transbordos: costos[fin].transbordos,
  };
}

// ── GET /api/ruta ────────────────────────────────────────────
// ?lat_origen=13.6923&lon_origen=-89.1833
// &lat_destino=13.7012&lon_destino=-89.1900
router.get('/', async (req, res) => {
  const { lat_origen, lon_origen, lat_destino, lon_destino } = req.query;

  if (!lat_origen || !lon_origen || !lat_destino || !lon_destino) {
    return res.status(400).json({
      error: 'Se requieren lat_origen, lon_origen, lat_destino, lon_destino'
    });
  }

  // Radio de búsqueda en metros — cubre rutas que no pasan exactamente por el punto
  const RADIO_M = 2000;

  try {
    // ── 1 & 2. Parada más cercana POR RUTA dentro del radio ──
    // Garantiza que ninguna ruta activa quede excluida por el límite de candidatos
    const candidatosPorRuta = async (lon, lat) => {
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (ppr.id_ruta, ppr.direccion)
          p.id_parada, p.nombre, p.latitud, p.longitud,
          ROUND(ST_Distance(p.geom, ST_MakePoint($1,$2)::GEOGRAPHY)::NUMERIC, 2) AS distancia_m
        FROM paradas_por_ruta ppr
        JOIN paradas p ON ppr.id_parada_origen = p.id_parada
        JOIN rutas   r ON ppr.id_ruta = r.id_ruta
        WHERE r.activa = true
          AND ST_DWithin(p.geom, ST_MakePoint($1,$2)::GEOGRAPHY, $3)
        ORDER BY ppr.id_ruta, ppr.direccion, p.geom <-> ST_MakePoint($1,$2)::GEOGRAPHY
      `, [parseFloat(lon), parseFloat(lat), RADIO_M]);

      // Deduplicar por id_parada conservando la menor distancia
      const mapa = new Map();
      for (const row of rows) {
        const prev = mapa.get(row.id_parada);
        if (!prev || parseFloat(row.distancia_m) < parseFloat(prev.distancia_m)) {
          mapa.set(row.id_parada, row);
        }
      }
      return [...mapa.values()];
    };

    const [paradasOrigen, paradasDestino] = await Promise.all([
      candidatosPorRuta(lon_origen, lat_origen),
      candidatosPorRuta(lon_destino, lat_destino),
    ]);

    if (paradasOrigen.length === 0 || paradasDestino.length === 0) {
      return res.status(404).json({
        error: `No se encontraron paradas de bus dentro de ${RADIO_M}m del ${paradasOrigen.length === 0 ? 'origen' : 'destino'}`
      });
    }

    // Ordenar por distancia para que [0] siga siendo la más cercana
    paradasOrigen.sort((a, b) => parseFloat(a.distancia_m) - parseFloat(b.distancia_m));
    paradasDestino.sort((a, b) => parseFloat(a.distancia_m) - parseFloat(b.distancia_m));

    if (paradasOrigen[0].id_parada === paradasDestino[0].id_parada) {
      return res.json({
        mensaje: 'El origen y destino corresponden a la misma parada',
        parada: paradasOrigen[0]
      });
    }

    // ── 3. Cargar el grafo completo desde la base de datos ───────────
    // Aristas normales entre paradas consecutivas de una ruta
    const resAristas = await pool.query(`
      SELECT id_parada_origen, id_parada_destino,
             id_ruta, direccion,
             COALESCE(distancia_m, 100) AS peso
      FROM paradas_por_ruta
      WHERE id_parada_origen <> id_parada_destino
    `);

    // ── 4. Construir el grafo en memoria ──────────────────────
    // Los cambios de ruta en paradas compartidas son implícitos:
    // varias rutas tienen edges desde el mismo id_parada, y Dijkstra
    // penaliza el cambio de ruta con es_transbordo * 100,000.
    const grafo = {};

    for (const a of resAristas.rows) {
      if (!grafo[a.id_parada_origen]) grafo[a.id_parada_origen] = [];
      grafo[a.id_parada_origen].push({
        nodo:      a.id_parada_destino,
        peso:      parseFloat(a.peso),
        id_ruta:   a.id_ruta,
        direccion: a.direccion,
      });
    }

    // ── 5. Ejecutar Dijkstra ──────────────────────────────────
    // Misma función de costo que usa Dijkstra internamente:
    // prioriza menos transbordos; desempata por distancia de bus.
    const scoreCamino = (r) => r.total_transbordos * 100000 + r.distancia_total_m;

    let resultado = null;
    let mejorOrigen  = paradasOrigen[0];
    let mejorDestino = paradasDestino[0];

    for (const po of paradasOrigen) {
      for (const pd of paradasDestino) {
        if (po.id_parada === pd.id_parada) continue;
        const intento = dijkstra(grafo, po.id_parada, pd.id_parada);
        if (intento && (!resultado || scoreCamino(intento) < scoreCamino(resultado))) {
          resultado    = intento;
          mejorOrigen  = po;
          mejorDestino = pd;
        }
      }
    }

    // ── 6. Guard: sin ruta encontrada
    if (!resultado) {
      return res.status(404).json({ error: 'No se encontró ruta entre los puntos indicados' });
    }

    // ── 7. Enriquecer el camino con nombres de paradas y rutas
    const ids_paradas = [...new Set(resultado.camino.map(p => p.id_parada))];
    const ids_rutas   = [...new Set(resultado.camino.map(p => p.id_ruta).filter(Boolean))];

    const resNombresParadas = await pool.query(`
      SELECT id_parada, nombre, latitud, longitud, municipio
      FROM paradas WHERE id_parada = ANY($1)
    `, [ids_paradas]);

    const resNombresRutas = await pool.query(`
      SELECT id_ruta, nombre_ruta FROM rutas WHERE id_ruta = ANY($1)
    `, [ids_rutas]);

    const mapaParadas = Object.fromEntries(
      resNombresParadas.rows.map(p => [p.id_parada, p])
    );
    const mapaRutas = Object.fromEntries(
      resNombresRutas.rows.map(r => [r.id_ruta, r.nombre_ruta])
    );

    const camino_detallado = resultado.camino.map(paso => ({
      id_parada:  paso.id_parada,
      nombre:     mapaParadas[paso.id_parada]?.nombre,
      latitud:    mapaParadas[paso.id_parada]?.latitud,
      longitud:   mapaParadas[paso.id_parada]?.longitud,
      municipio:  mapaParadas[paso.id_parada]?.municipio,
      ruta:       paso.id_ruta ? mapaRutas[paso.id_ruta] : null,
      direccion:  paso.direccion,
    }));

    // ── 7. Detectar transbordos en el camino ──────────────────
    const transbordos_en_ruta = [];
    for (let i = 1; i < camino_detallado.length; i++) {
      const anterior = camino_detallado[i - 1];
      const actual   = camino_detallado[i];
      if (anterior.ruta && actual.ruta && anterior.ruta !== actual.ruta) {
        transbordos_en_ruta.push({
          en_parada: actual.nombre,
          de_ruta:   anterior.ruta,
          a_ruta:    actual.ruta,
        });
      }
    }

        res.json({
    origen: {
    parada:      mejorOrigen.nombre,
    distancia_m: mejorOrigen.distancia_m,
  },
    destino: {
    parada:      mejorDestino.nombre,
    distancia_m: mejorDestino.distancia_m,
  },
    distancia_total_m:  Math.round(resultado.distancia_total_m),
    transbordos:        transbordos_en_ruta,
    total_transbordos:  transbordos_en_ruta.length,
    checkpoints: camino_detallado.map(p => ({
    latitude:  parseFloat(p.latitud),
    longitude: parseFloat(p.longitud),
    nombre:    p.nombre,
    ruta:      p.ruta,
    direccion: p.direccion,
  })),
    camino: camino_detallado,
});

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al calcular la ruta' });
  }
});

module.exports = router;