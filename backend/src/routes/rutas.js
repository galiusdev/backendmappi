const express = require('express');
const router  = express.Router();
const pool    = require('../db');

// GET /api/rutas
// Retorna el listado de todas las rutas
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id_ruta, nombre_ruta, activa
      FROM rutas
      ORDER BY nombre_ruta
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener las rutas' });
  }
});

// GET /api/rutas/:id/paradas?direccion=I
// Retorna todas las paradas de una ruta en orden de secuencia
router.get('/:id/paradas', async (req, res) => {
  const { id }       = req.params;
  const { direccion } = req.query;

  if (!direccion || !['I', 'R'].includes(direccion)) {
    return res.status(400).json({ error: 'El parámetro direccion debe ser I o R' });
  }

  try {
    const result = await pool.query(`
      SELECT
        p.id_parada,
        p.nombre,
        p.latitud,
        p.longitud,
        p.municipio,
        ppr.orden_secuencia,
        ppr.direccion,
        ppr.distancia_m
      FROM paradas_por_ruta ppr
      JOIN paradas p ON ppr.id_parada_origen = p.id_parada
      WHERE ppr.id_ruta   = $1
        AND ppr.direccion = $2
      ORDER BY ppr.orden_secuencia
    `, [parseInt(id), direccion]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener las paradas de la ruta' });
  }
});

// GET /api/rutas/:id/transbordos
// Retorna todos los puntos de transbordo de una ruta
router.get('/:id/transbordos', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(`
      SELECT
        p.id_parada,
        p.nombre,
        p.latitud,
        p.longitud,
        r.id_ruta        AS ruta_conexion_id,
        r.nombre_ruta    AS ruta_conexion
      FROM transbordos t
      JOIN paradas p ON t.id_parada  = p.id_parada
      JOIN rutas   r ON t.id_ruta_b  = r.id_ruta
      WHERE t.id_ruta_a = $1
      ORDER BY p.nombre
    `, [parseInt(id)]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener los transbordos' });
  }
});

module.exports = router;