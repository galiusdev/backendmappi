const express = require('express');
const router  = express.Router();
const pool    = require('../db');

// GET /api/paradas/cercana?lat=13.6923&lon=-89.1833
// Retorna las 5 paradas más cercanas a una ubicación
router.get('/cercana', async (req, res) => {
  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: 'Se requieren los parámetros lat y lon' });
  }

  try {
    const result = await pool.query(`
      SELECT
        p.id_parada,
        p.nombre,
        p.latitud,
        p.longitud,
        p.municipio,
        p.departamento,
        ROUND(ST_Distance(
          p.geom,
          ST_MakePoint($1, $2)::GEOGRAPHY
        )::NUMERIC, 2) AS distancia_m
      FROM paradas p
      ORDER BY p.geom <-> ST_MakePoint($1, $2)::GEOGRAPHY
      LIMIT 5
    `, [parseFloat(lon), parseFloat(lat)]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al buscar paradas cercanas' });
  }
});

// GET /api/paradas/:id
// Retorna el detalle de una parada y todas las rutas que pasan por ella
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(`
      SELECT
        p.id_parada,
        p.nombre,
        p.latitud,
        p.longitud,
        p.municipio,
        p.departamento,
        json_agg(
          json_build_object(
            'id_ruta',       r.id_ruta,
            'nombre_ruta',   r.nombre_ruta,
            'direccion',     ppr.direccion
          )
        ) AS rutas
      FROM paradas p
      JOIN paradas_por_ruta ppr ON p.id_parada = ppr.id_parada_origen
      JOIN rutas r ON ppr.id_ruta = r.id_ruta
      WHERE p.id_parada = $1
      GROUP BY p.id_parada
    `, [parseInt(id)]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Parada no encontrada' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener la parada' });
  }
});

module.exports = router;