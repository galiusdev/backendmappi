-- ============================================================
--  SCHEMA: App de Transporte Público AMSS
--  Base de datos: PostgreSQL + PostGIS
--  Fuente: DATOSCRUDOSMAR2026paradas-transporte-colectivo-amss
--  Filas válidas: 9,353 (se descarta fila fantasma FID 9354)
--  Rutas: 182 | Direcciones: I (Ida) y R (Regreso)
--  Departamentos: San Salvador, La Libertad, Cuscatlán, La Paz
-- ============================================================

-- Habilitar la extensión espacial de PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;


-- ============================================================
--  TABLA 1: rutas
--  Catálogo de las 182 rutas del AMSS.
-- ============================================================
CREATE TABLE rutas (
    id_ruta     SERIAL PRIMARY KEY,
    nombre_ruta VARCHAR(100) NOT NULL UNIQUE,  -- ej: "RUTA A", "MB RUTA 2A"
    descripcion TEXT,
    activa      BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en   TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ============================================================
--  TABLA 2: paradas
--  Cada parada física única — los NODOS del grafo.
--  La columna `geom` es el punto espacial que PostGIS
--  usa para búsquedas de proximidad con índice GiST.
-- ============================================================
CREATE TABLE paradas (
    id_parada    SERIAL PRIMARY KEY,
    nombre       TEXT NOT NULL,               -- descripción de la parada del Excel
    latitud      NUMERIC(18, 11) NOT NULL,
    longitud     NUMERIC(18, 11) NOT NULL,
    geom         GEOGRAPHY(POINT, 4326),      -- columna espacial (SRID 4326 = WGS84)
    municipio    VARCHAR(100),                -- ej: "San Salvador"
    departamento VARCHAR(100),                -- ej: "SAN SALVADOR"
    fid_original INTEGER,                     -- FID_L0Coor del Excel original
    creado_en    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Índice espacial GiST: hace muy rápida la búsqueda de parada más cercana
CREATE INDEX idx_paradas_geom ON paradas USING GIST (geom);

-- Índice para búsqueda por municipio/departamento
CREATE INDEX idx_paradas_municipio ON paradas (municipio);


-- ============================================================
--  TABLA 3: paradas_por_ruta
--  Las ARISTAS del grafo dirigido.
--  Cada fila conecta una parada con la siguiente
--  dentro de una ruta y dirección específica.
--  El campo `orden_secuencia` permite reconstruir
--  el recorrido completo de cualquier ruta.
-- ============================================================
CREATE TABLE paradas_por_ruta (
    id                  SERIAL PRIMARY KEY,
    id_ruta             INTEGER NOT NULL REFERENCES rutas(id_ruta) ON DELETE CASCADE,
    id_parada_origen    INTEGER NOT NULL REFERENCES paradas(id_parada) ON DELETE CASCADE,
    id_parada_destino   INTEGER NOT NULL REFERENCES paradas(id_parada) ON DELETE CASCADE,
    orden_secuencia     INTEGER NOT NULL,     -- posición de la parada origen en el recorrido
    direccion           CHAR(1) NOT NULL CHECK (direccion IN ('I', 'R')),  -- I=Ida, R=Regreso
    distancia_m         NUMERIC(10, 2),       -- metros entre origen y destino (calculado con haversine)
    creado_en           TIMESTAMP NOT NULL DEFAULT NOW(),

    -- Una misma parada no puede aparecer dos veces en la misma ruta/dirección/orden
    CONSTRAINT uq_parada_orden UNIQUE (id_ruta, direccion, orden_secuencia)
);

-- Índices para las consultas del algoritmo de rutas
CREATE INDEX idx_ppr_ruta      ON paradas_por_ruta (id_ruta);
CREATE INDEX idx_ppr_origen    ON paradas_por_ruta (id_parada_origen);
CREATE INDEX idx_ppr_destino   ON paradas_por_ruta (id_parada_destino);
CREATE INDEX idx_ppr_direccion ON paradas_por_ruta (direccion);


-- ============================================================
--  TABLA 4: transbordos
--  Paradas donde dos o más rutas se cruzan.
--  Se genera automáticamente al poblar paradas_por_ruta:
--  si una misma parada aparece en dos rutas distintas,
--  es un punto de transbordo.
--  Esta tabla la consulta el algoritmo de Dijkstra
--  para saltar de una ruta a otra.
-- ============================================================
CREATE TABLE transbordos (
    id              SERIAL PRIMARY KEY,
    id_parada       INTEGER NOT NULL REFERENCES paradas(id_parada) ON DELETE CASCADE,
    id_ruta_a       INTEGER NOT NULL REFERENCES rutas(id_ruta) ON DELETE CASCADE,
    id_ruta_b       INTEGER NOT NULL REFERENCES rutas(id_ruta) ON DELETE CASCADE,
    tiempo_espera_min INTEGER DEFAULT 5,      -- estimado de espera al cambiar de ruta
    creado_en       TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_transbordo UNIQUE (id_parada, id_ruta_a, id_ruta_b),
    CONSTRAINT chk_rutas_distintas CHECK (id_ruta_a <> id_ruta_b)
);

CREATE INDEX idx_transbordos_parada ON transbordos (id_parada);
CREATE INDEX idx_transbordos_ruta_a ON transbordos (id_ruta_a);
CREATE INDEX idx_transbordos_ruta_b ON transbordos (id_ruta_b);


-- ============================================================
--  FUNCIÓN: actualizar geom automáticamente
--  Cada vez que se inserta o actualiza una parada,
--  PostGIS construye el punto espacial desde lat/lon.
-- ============================================================
CREATE OR REPLACE FUNCTION fn_actualizar_geom()
RETURNS TRIGGER AS $$
BEGIN
    NEW.geom = ST_SetSRID(
        ST_MakePoint(NEW.longitud, NEW.latitud),
        4326
    )::GEOGRAPHY;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_actualizar_geom
BEFORE INSERT OR UPDATE OF latitud, longitud
ON paradas
FOR EACH ROW
EXECUTE FUNCTION fn_actualizar_geom();


-- ============================================================
--  VISTA: paradas_con_rutas
--  Útil para el backend: dado un id_parada,
--  retorna todas las rutas que pasan por ella.
-- ============================================================
CREATE VIEW paradas_con_rutas AS
SELECT
    p.id_parada,
    p.nombre,
    p.latitud,
    p.longitud,
    p.municipio,
    p.departamento,
    r.id_ruta,
    r.nombre_ruta,
    ppr.direccion,
    ppr.orden_secuencia
FROM paradas p
JOIN paradas_por_ruta ppr ON p.id_parada = ppr.id_parada_origen
JOIN rutas r ON ppr.id_ruta = r.id_ruta
ORDER BY p.id_parada, r.nombre_ruta, ppr.direccion, ppr.orden_secuencia;


-- ============================================================
--  CONSULTA DE EJEMPLO: parada más cercana a una ubicación
--  Reemplaza los valores de latitud y longitud por los
--  del usuario en tiempo real desde el backend Node.js.
--
--  SELECT id_parada, nombre, municipio,
--         ST_Distance(geom, ST_MakePoint(-89.1833, 13.6923)::GEOGRAPHY) AS distancia_m
--  FROM paradas
--  ORDER BY geom <-> ST_MakePoint(-89.1833, 13.6923)::GEOGRAPHY
--  LIMIT 5;
-- ============================================================
