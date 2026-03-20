"""
generar_inserts.py
------------------
Lee el Excel de paradas del AMSS y genera un archivo SQL
listo para ejecutar en PostgreSQL + PostGIS.

Genera INSERTs para:
  1. rutas            (182 rutas únicas)
  2. paradas          (paradas físicas únicas por coordenada)
  3. paradas_por_ruta (aristas del grafo dirigido)
  4. transbordos      (paradas compartidas entre rutas)

Uso:
    python generar_inserts.py

Requisitos:
    pip install openpyxl
"""

import math
import re
from collections import defaultdict

import openpyxl

# ── Configuración ────────────────────────────────────────────
ARCHIVO_EXCEL = "DATOSCRUDOSMAR2026paradas-transporte-colectivo-amss.xlsx"
ARCHIVO_SQL   = "data_transporte_amss.sql"
# ────────────────────────────────────────────────────────────


def haversine(lat1, lon1, lat2, lon2):
    """Distancia en metros entre dos puntos geográficos."""
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi        = math.radians(lat2 - lat1)
    dlambda     = math.radians(lon2 - lon1)
    a = (math.sin(dphi / 2) ** 2
         + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def esc(valor):
    """Escapa comillas simples para cadenas SQL."""
    if valor is None:
        return "NULL"
    return "'" + str(valor).replace("'", "''") + "'"


# ── 1. Leer Excel ────────────────────────────────────────────
print("Leyendo Excel...")
wb = openpyxl.load_workbook(ARCHIVO_EXCEL, read_only=True)
ws = wb.active

filas_raw = list(ws.iter_rows(min_row=2, values_only=True))

# Descartar fila fantasma (FID 9354, todos los campos de parada vacíos)
filas = [
    r for r in filas_raw
    if r[1] is not None       # ruta no vacía
    and r[5] not in (None, 0) # latitud válida
    and r[6] not in (None, 0) # longitud válida
]

print(f"  Filas válidas: {len(filas)} (descartadas: {len(filas_raw) - len(filas)})")


# ── 2. Construir catálogo de RUTAS ───────────────────────────
print("Procesando rutas...")
nombres_ruta = sorted(set(r[1].strip() for r in filas))
# id_ruta empieza en 1
ruta_a_id = {nombre: idx + 1 for idx, nombre in enumerate(nombres_ruta)}
print(f"  Rutas únicas: {len(ruta_a_id)}")


# ── 3. Construir catálogo de PARADAS únicas ──────────────────
#
#  Una parada física = combinación única de (latitud, longitud).
#  Redondeamos a 6 decimales (~11 cm de precisión) para agrupar
#  registros que son el mismo punto físico en distintas rutas.
#  Esto es lo que convierte esas 9,353 filas en nodos únicos
#  del grafo y genera la tabla de transbordos automáticamente.
#
print("Procesando paradas únicas...")
coord_a_id   = {}   # (lat_r, lon_r) -> id_parada
paradas_meta = {}   # id_parada -> dict con todos los campos

id_parada_counter = 1

for r in filas:
    fid, ruta, cod, nombre, coord_txt, lat, lon, fcode, dep, na3, mun = r
    lat_r = round(float(lat), 6)
    lon_r = round(float(lon), 6)
    clave = (lat_r, lon_r)

    if clave not in coord_a_id:
        coord_a_id[clave] = id_parada_counter
        paradas_meta[id_parada_counter] = {
            "id_parada":    id_parada_counter,
            "nombre":       nombre,
            "latitud":      lat,
            "longitud":     lon,
            "municipio":    mun,
            "departamento": dep,
            "fid_original": fid,
        }
        id_parada_counter += 1

print(f"  Paradas únicas: {len(paradas_meta)}")


# ── 4. Construir ARISTAS (paradas_por_ruta) ──────────────────
#
#  Para cada ruta + dirección, ordenamos las paradas por FID.
#  Cada par consecutivo (parada_N, parada_N+1) es una arista
#  del grafo dirigido con su distancia en metros como peso.
#
print("Construyendo aristas del grafo...")

# Agrupar filas por (ruta, dirección)
grupos = defaultdict(list)
for r in filas:
    fid, ruta, cod = r[0], r[1].strip(), r[2]
    grupos[(ruta, cod)].append(r)

aristas = []  # lista de dicts listos para INSERT

for (ruta, cod), paradas_grupo in grupos.items():
    # Ordenar por FID para respetar la secuencia del recorrido
    paradas_grupo.sort(key=lambda x: x[0])
    id_ruta = ruta_a_id[ruta]

    for orden, r in enumerate(paradas_grupo):
        lat_r = round(float(r[5]), 6)
        lon_r = round(float(r[6]), 6)
        id_origen = coord_a_id[(lat_r, lon_r)]

        # La última parada de la ruta no tiene destino siguiente
        if orden < len(paradas_grupo) - 1:
            r_sig  = paradas_grupo[orden + 1]
            lat_r2 = round(float(r_sig[5]), 6)
            lon_r2 = round(float(r_sig[6]), 6)
            id_destino = coord_a_id[(lat_r2, lon_r2)]
            distancia  = round(haversine(float(r[5]), float(r[6]),
                                         float(r_sig[5]), float(r_sig[6])), 2)
        else:
            id_destino = id_origen  # última parada: apunta a sí misma
            distancia  = 0.0

        aristas.append({
            "id_ruta":          id_ruta,
            "id_parada_origen": id_origen,
            "id_parada_destino":id_destino,
            "orden_secuencia":  orden + 1,
            "direccion":        cod,
            "distancia_m":      distancia,
        })

print(f"  Aristas generadas: {len(aristas)}")


# ── 5. Detectar TRANSBORDOS ──────────────────────────────────
#
#  Una parada es punto de transbordo si aparece en 2+ rutas
#  distintas. Por cada par de rutas que comparten una parada,
#  generamos un registro en transbordos.
#
print("Detectando transbordos...")

# Mapear id_parada -> set de id_rutas que pasan por ella
parada_a_rutas = defaultdict(set)
for a in aristas:
    parada_a_rutas[a["id_parada_origen"]].add(a["id_ruta"])

transbordos = []
transbordos_vistos = set()  # evitar duplicados (A,B) y (B,A)

for id_parada, rutas_set in parada_a_rutas.items():
    if len(rutas_set) < 2:
        continue
    rutas_lista = sorted(rutas_set)
    for i in range(len(rutas_lista)):
        for j in range(i + 1, len(rutas_lista)):
            ruta_a = rutas_lista[i]
            ruta_b = rutas_lista[j]
            clave  = (id_parada, ruta_a, ruta_b)
            if clave not in transbordos_vistos:
                transbordos_vistos.add(clave)
                transbordos.append({
                    "id_parada": id_parada,
                    "id_ruta_a": ruta_a,
                    "id_ruta_b": ruta_b,
                    "tiempo_espera_min": 5,
                })

print(f"  Transbordos detectados: {len(transbordos)}")


# ── 6. Escribir SQL ──────────────────────────────────────────
print(f"Escribiendo {ARCHIVO_SQL}...")

with open(ARCHIVO_SQL, "w", encoding="utf-8") as f:

    f.write("-- ============================================================\n")
    f.write("--  DATA: App de Transporte Público AMSS\n")
    f.write(f"--  Rutas: {len(ruta_a_id)} | Paradas únicas: {len(paradas_meta)}\n")
    f.write(f"--  Aristas: {len(aristas)} | Transbordos: {len(transbordos)}\n")
    f.write("--  IMPORTANTE: ejecutar DESPUÉS de schema_transporte_amss.sql\n")
    f.write("-- ============================================================\n\n")

    f.write("BEGIN;\n\n")

    # ── INSERT rutas ─────────────────────────────────────────
    f.write("-- ------------------------------------------------------------\n")
    f.write(f"-- RUTAS ({len(ruta_a_id)} registros)\n")
    f.write("-- ------------------------------------------------------------\n")
    f.write("INSERT INTO rutas (id_ruta, nombre_ruta, activa) VALUES\n")
    lineas = []
    for nombre, id_r in sorted(ruta_a_id.items(), key=lambda x: x[1]):
        lineas.append(f"  ({id_r}, {esc(nombre)}, TRUE)")
    f.write(",\n".join(lineas))
    f.write(";\n\n")

    # Resetear secuencia para que futuros INSERTs no colisionen
    f.write(f"SELECT setval('rutas_id_ruta_seq', {len(ruta_a_id)});\n\n")

    # ── INSERT paradas ───────────────────────────────────────
    f.write("-- ------------------------------------------------------------\n")
    f.write(f"-- PARADAS ÚNICAS ({len(paradas_meta)} registros)\n")
    f.write("-- El trigger trg_actualizar_geom construye la columna geom\n")
    f.write("-- automáticamente desde latitud y longitud.\n")
    f.write("-- ------------------------------------------------------------\n")
    f.write("INSERT INTO paradas (id_parada, nombre, latitud, longitud, municipio, departamento, fid_original) VALUES\n")
    lineas = []
    for id_p, meta in sorted(paradas_meta.items()):
        lineas.append(
            f"  ({meta['id_parada']}, {esc(meta['nombre'])}, "
            f"{meta['latitud']}, {meta['longitud']}, "
            f"{esc(meta['municipio'])}, {esc(meta['departamento'])}, "
            f"{meta['fid_original']})"
        )
    f.write(",\n".join(lineas))
    f.write(";\n\n")

    f.write(f"SELECT setval('paradas_id_parada_seq', {len(paradas_meta)});\n\n")

    # ── INSERT paradas_por_ruta ──────────────────────────────
    f.write("-- ------------------------------------------------------------\n")
    f.write(f"-- PARADAS POR RUTA / ARISTAS DEL GRAFO ({len(aristas)} registros)\n")
    f.write("-- ------------------------------------------------------------\n")

    # Insertar en bloques de 500 para no generar un INSERT gigante
    BLOQUE = 500
    for inicio in range(0, len(aristas), BLOQUE):
        bloque = aristas[inicio:inicio + BLOQUE]
        f.write("INSERT INTO paradas_por_ruta "
                "(id_ruta, id_parada_origen, id_parada_destino, "
                "orden_secuencia, direccion, distancia_m) VALUES\n")
        lineas = []
        for a in bloque:
            lineas.append(
                f"  ({a['id_ruta']}, {a['id_parada_origen']}, "
                f"{a['id_parada_destino']}, {a['orden_secuencia']}, "
                f"'{a['direccion']}', {a['distancia_m']})"
            )
        f.write(",\n".join(lineas))
        f.write(";\n\n")

    f.write(f"SELECT setval('paradas_por_ruta_id_seq', {len(aristas)});\n\n")

    # ── INSERT transbordos ───────────────────────────────────
    f.write("-- ------------------------------------------------------------\n")
    f.write(f"-- TRANSBORDOS ({len(transbordos)} registros)\n")
    f.write("-- ------------------------------------------------------------\n")

    for inicio in range(0, len(transbordos), BLOQUE):
        bloque = transbordos[inicio:inicio + BLOQUE]
        f.write("INSERT INTO transbordos "
                "(id_parada, id_ruta_a, id_ruta_b, tiempo_espera_min) VALUES\n")
        lineas = []
        for t in bloque:
            lineas.append(
                f"  ({t['id_parada']}, {t['id_ruta_a']}, "
                f"{t['id_ruta_b']}, {t['tiempo_espera_min']})"
            )
        f.write(",\n".join(lineas))
        f.write(";\n\n")

    f.write(f"SELECT setval('transbordos_id_seq', {len(transbordos)});\n\n")

    f.write("COMMIT;\n")

print("Listo.")
print(f"\nResumen final:")
print(f"  Rutas:            {len(ruta_a_id):>6}")
print(f"  Paradas únicas:   {len(paradas_meta):>6}")
print(f"  Aristas (grafo):  {len(aristas):>6}")
print(f"  Transbordos:      {len(transbordos):>6}")
