# Scraper de Jurisprudencia — Poder Judicial del Perú

Scraper en **TypeScript** (sin automatización de navegador) del portal de
jurisprudencia del Poder Judicial del Perú. Recorre el sitio, extrae **todos los
metadatos y la ficha completa** de cada resolución y **descarga los PDFs**, con
manejo de *rate limiting* (HTTP 429), reintentos con **backoff exponencial**,
*logging* de progreso y **reanudación** ante interrupciones.

> Sitio: `https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml`
> El flujo real arranca en `inicio.xhtml` y, al pulsar "Buscar", redirige a
> `resultado.xhtml`. El scraper reproduce ese flujo.

---

## Índice

1. [Hallazgos clave del sitio](#1-hallazgos-clave-del-sitio)
2. [Requisitos previos](#2-requisitos-previos)
3. [Instalación](#3-instalación)
4. [Configuración](#4-configuración)
5. [Ejecución](#5-ejecución)
6. [Salidas](#6-salidas)
7. [Manejo de 429 y resiliencia](#7-manejo-de-429-y-resiliencia)
8. [Arquitectura](#8-arquitectura)
9. [Decisiones de diseño](#9-decisiones-de-diseño)
10. [Limitaciones y trabajo futuro](#10-limitaciones-y-trabajo-futuro)
11. [Cumplimiento del desafío](#11-cumplimiento-del-desafío)

---

## 1. Hallazgos clave del sitio

Todo lo siguiente fue **verificado con tráfico HTTP real**:

- **No es PrimeFaces**: el sitio usa **RichFaces 4.2.2** sobre **JSF (Mojarra)**.
  Hay **sesión con estado** (`JSESSIONID` + `javax.faces.ViewState`).
- **La búsqueda exige filtros**: una búsqueda vacía se rechaza con *"Debe ingresar
  filtros de información"*. El scraper enumera el sitio por facetas **Corte × Año**.
- **"Buscar"** es un POST de página completa (`mojarra.jsfcljs`) que redirige
  (`302`) a `resultado.xhtml` (patrón **POST-Redirect-GET**).
- **Cada fila** lleva un `uuid` estable y un resumen; la **ficha completa** (~35
  campos en 3 secciones) se obtiene de un **modal** (AJAX) que hace *lookup* por `uuid`.
- **Paginación**: AJAX parcial de RichFaces con el parámetro
  `formBuscador:data1:page=N` (salto directo a cualquier página).
- **PDF**: `GET /jurisprudenciaweb/ServletDescarga?uuid=<uuid>` (no necesita
  ViewState). El `uuid` es la clave que une el JSON con su PDF.

---

## 2. Requisitos previos

- **Node.js ≥ 20** y npm.
- **Acceso al sitio** (el portal requiere **VPN a Perú**). El acceso se asume
  resuelto en el equipo de desarrollo.

---

## 3. Instalación

```bash
cd scraper-challenge
npm install
```

---

## 4. Configuración

**Todo** se controla desde [`src/config.ts`](./src/config.ts) — sin argumentos de
consola ni interfaces interactivas. Para cambiar el alcance, edita `executionMode`:

| `executionMode`  | Qué hace                                                        |
| ---------------- | --------------------------------------------------------------- |
| `FIRST_PAGE`     | Solo la 1ª página de la faceta de referencia (≈10 documentos).  |
| `FIRST_5_PAGES`  | Las primeras 5 páginas de la faceta de referencia (≈50 docs).   |
| `ALL`            | Recorre todo el sitio enumerando facetas **Corte × Año**.       |

Parámetros principales (todos documentados en `config.ts`):

| Parámetro                  | Default        | Descripción                                              |
| -------------------------- | -------------- | -------------------------------------------------------- |
| `executionMode`            | `FIRST_PAGE`   | Alcance del recorrido.                                    |
| `referenceFacet`           | `{1, 2024}`    | Faceta (corte, año) para los modos de desarrollo.        |
| `delayBetweenRequests`     | `1500` ms      | Pausa mínima entre peticiones (no saturar el servidor).  |
| `maxRetries429`            | `5`            | Reintentos ante 429 antes de rendirse.                   |
| `maxRetriesTransient`      | `4`            | Reintentos ante 5xx / timeouts / errores de red.         |
| `retryBackoffBase`         | `1000` ms      | Base del backoff exponencial.                            |
| `retryBackoffMaxDelay`     | `60000` ms     | Techo de la espera de backoff.                           |
| `retryJitter`              | `true`         | Jitter aleatorio en el backoff.                          |
| `requestTimeout`           | `30000` ms     | Timeout por petición.                                    |
| `fetchFichaModal`          | `true`         | Disparar el modal "Ficha" (fuente principal de datos).   |
| `downloadPdfs`             | `true`         | Descargar los PDFs.                                      |
| `concurrentPdfDownloads`   | `2`            | Descargas de PDF concurrentes.                           |
| `outputDirectory`          | `./output`     | Carpeta raíz de salida.                                  |
| `resumeFailedDownloads`    | `true`         | Reintentar la cola de fallidos al iniciar.               |
| `logLevel`                 | `info`         | Verbosidad (`debug`/`info`/`warn`/`error`).              |

---

## 5. Ejecución

```bash
# Ejecuta el scraper con la configuración de config.ts
npm run scrape

# Verificación de tipos (sin emitir)
npm run typecheck

# Compilar a dist/ y ejecutar el JS compilado
npm run build && node dist/main.js
```

**Recomendado**: empezar con `FIRST_PAGE`, comprobar las salidas, y solo entonces
subir a `FIRST_5_PAGES` o `ALL`.

---

## 6. Salidas

```
output/
├─ data/
│  ├─ documents.ndjson     # 1 documento JSON por línea (incremental, resiliente)
│  └─ documents.json       # array agregado, generado al finalizar
├─ pdfs/
│  └─ <Corte>/<Año>/<recurso>_<nroExpediente>_<fecha>_<uuid>.pdf
├─ state/
│  ├─ checkpoint.json      # reanudación (faceta/página completada)
│  └─ failed.ndjson        # documentos/descargas fallidas (reintentables)
└─ logs/
   └─ run-<timestamp>.log  # una línea JSON por evento
```

Cada documento es **un único objeto enriquecido** que fusiona el resumen del
listado, la **ficha completa** del modal y los metadatos del PDF:

```jsonc
{
  "uuid": "9dc0ebac-76b0-4207-906a-dd3b441483ad",
  "nroExpediente": "007125-2023",
  "recurso": "Apelación",
  "tipoResolucion": "Ejecutoria Suprema",
  "fechaResolucion": "28/12/2024",
  "sala": "...",
  "corte": "Suprema",
  "anio": 2024,
  "pretensiones": ["Revisión de Procedimiento Coactivo"],
  "palabrasClave": [],
  "sumilla": null,
  "ficha": {
    "titulo": "Apelación - 007125-2023",
    "datosResolucion": { "Ponente": "DELGADO AYBAR", "Jueces Supremos": "...", "...": "..." },
    "datosProceso":    { "Distrito Judicial de Procedencia": "Lima", "...": "..." },
    "datosProcedencia":{ "Fecha de Demanda": "10/10/2017", "...": "..." }
  },
  "pdf": {
    "downloadUrl": ".../ServletDescarga?uuid=9dc0ebac-...",
    "serverFilename": "Resolucion_11_20241228105201000545398.pdf",
    "localPath": "pdfs/Suprema/2024/Apelacion_007125-2023_2024-12-28_9dc0ebac-76b0-4207-906a-dd3b441483ad.pdf",
    "status": "downloaded", "bytes": 287810, "sha256": "...", "attempts": 1, "error": null
  },
  "_meta": { "facet": { "corte": 1, "anio": 2024 }, "page": 1, "rowIndex": 9, "scrapedAt": "..." }
}
```

**Nomenclatura de PDFs:** `<recurso>_<nroExpediente>_<fecha>_<uuid>.pdf`
(p.ej. `Casacion_012722-2021_2023-12-29_26ec07bf-ca63-46dd-802d-d5cddd52ea64.pdf`).
Combina una parte **descriptiva** legible —recurso + nº de expediente + fecha
`yyyy-mm-dd`, saneados (sin acentos ni caracteres problemáticos)— con el **`uuid`**
como **identificador único** al final. El `uuid` garantiza la unicidad: el
`nroExpediente` **no** es único por sí solo (un expediente puede tener varias
resoluciones), por eso no basta como nombre. El `uuid` además mantiene la correlación
directa JSON↔PDF (es la clave del servlet de descarga). También se conserva el nombre
que sugiere el servidor en `pdf.serverFilename`.

---

## 7. Manejo de 429 y resiliencia

- **429 (Too Many Requests)**: backoff exponencial con jitter
  (`min(base·2^intento, max)`), respetando la cabecera `Retry-After` si viene.
  Hasta `maxRetries429` intentos; si persiste, el documento va a `failed.ndjson` y
  **el lote continúa** (nunca se aborta todo el proceso).
- **5xx / timeouts / errores de red**: reintento con backoff (presupuesto propio,
  `maxRetriesTransient`). *(En las pruebas el servidor devolvió 502 intermitentes.)*
- **Throttling preventivo**: `delayBetweenRequests` entre peticiones y baja
  concurrencia de descargas (`concurrentPdfDownloads`).
- **PDF corrupto / sesión caída**: se validan los *magic bytes* `%PDF-`; un 200 con
  HTML no se acepta como PDF.
- **Vista vacía transitoria (paginación)**: si una página llega vacía pero el
  **total** de la búsqueda inicial indica que aún deberían quedar resultados (cada
  página trae 10), **no** se asume el fin: se **recarga la búsqueda** y se reintenta
  esa página (`maxEmptyPageReloads`). La faceta solo se da por terminada cuando la
  página vacía coincide con el fin esperado según el total. Evita cortar
  prematuramente búsquedas de cientos de páginas por un fallo puntual del servidor.
- **Reanudación**: `checkpoint.json` guarda la última página completada por faceta;
  la deduplicación por `uuid` evita reprocesar. Reejecutar retoma donde se quedó.
- **Cola de fallidos**: con `resumeFailedDownloads`, al iniciar se reintentan las
  descargas que quedaron pendientes y se reconcilia el dataset.

---

## 8. Arquitectura

Separación por responsabilidad, sin sobreingeniería. Cada módulo es testeable de
forma aislada.

```
src/
├─ config.ts              # Configuración central (único punto de control)
├─ main.ts                # Composition root: arma e inyecta dependencias
├─ types.ts               # Tipos del dominio
├─ core/
│  ├─ orchestrator.ts     # Flujo: facetas → páginas → fichas → PDFs (+ reanudación)
│  └─ search-space.ts     # Enumeración de facetas (Corte × Año) según el modo
├─ http/
│  ├─ http-client.ts      # axios + cookie jar + throttle + timeout
│  ├─ retry-policy.ts     # Backoff exponencial; clasifica 429 / transitorios
│  └─ jsf-session.ts      # Estado JSF: ViewState, descubrimiento de botones
├─ scraping/
│  ├─ jsf-utils.ts        # Helpers puros de JSF/RichFaces (parsing, serialización)
│  ├─ search-client.ts    # Búsqueda (PRG) y paginación (dataScroller)
│  ├─ result-parser.ts    # Filas del listado y ficha del modal (cheerio)
│  ├─ ficha-client.ts     # Dispara el modal y devuelve la ficha completa
│  └─ pdf-downloader.ts   # GET al servlet, valida %PDF, guarda
├─ persistence/
│  ├─ json-store.ts       # NDJSON incremental + JSON agregado (dedup por uuid)
│  ├─ failed-queue.ts     # Cola de fallidos (reintentables)
│  └─ checkpoint.ts       # Reanudación por faceta/página
├─ logging/logger.ts      # Logging por niveles (consola + archivo JSON)
└─ utils/async.ts         # sleep, throttle global, pool de concurrencia
```

**Dependencias** (mínimas): `axios` (HTTP) y `cheerio` (parsing HTML), ambas
pedidas por el desafío. El *cookie jar* se gestiona internamente (un único
`JSESSIONID`), sin añadir librerías. No se usan Puppeteer/Playwright/Selenium
(prohibidos) ni frameworks innecesarios.

---

## 9. Decisiones de diseño

- **Recorrido por facetas (Corte × Año)**: el sitio exige filtros y una sola
  combinación puede superar 17 000 resultados; enumerar facetas mantiene las
  consultas acotadas, reanudables y evita topes de paginación.
- **Disparar el modal "Ficha"**: la fila es solo un resumen; el modal aporta ~35
  campos (jueces, ponente, fallo, procedencia, origen…). Es la fuente principal.
- **IDs JSF descubiertos, no hardcodeados**: los `j_idtNN` son autogenerados y
  cambian si recompilan la vista; se descubren parseando el HTML.
- **ViewState re-extraído** tras cada respuesta (regla de JSF) — sin esto, el
  segundo POST fallaría.
- **NDJSON incremental + dedup por uuid**: resiliencia y reanudación a gran escala.
- **Nombre de PDF descriptivo + `uuid`**: parte legible (recurso/expediente/fecha)
  para identificar el archivo de un vistazo, más el `uuid` que garantiza unicidad y
  correlación directa con el JSON.

---

## 10. Limitaciones y trabajo futuro

- **Tope de paginación**: no se verificó el máximo de páginas navegables para una
  faceta muy grande (>1 500 páginas). Si fuera necesario, el diseño contempla
  **subdividir** la faceta por especialidad/tipo de recurso (*facet drill-down*).
- **Variación de campos de la ficha**: el parser es tolerante a campos ausentes;
  otros tipos de resolución podrían exponer campos distintos.
- **429 real**: el portal lo garantiza por enunciado; no se forzó en las pruebas
  para no abusar del servidor. La lógica de backoff está implementada y probada con
  errores transitorios reales (502).

---

## 11. Cumplimiento del desafío

| Requisito                                              | Estado |
| ----------------------------------------------------- | ------ |
| TypeScript, sin automatización de navegador           | ✅ axios + cheerio |
| Navegar todo el sitio y descubrir la paginación        | ✅ facetas + dataScroller |
| Extraer toda la información de cada documento (+ficha)  | ✅ resumen + modal (~35 campos) |
| Descargar PDFs con nombre descriptivo                  | ✅ `<recurso>_<expediente>_<fecha>_<uuid>.pdf` + carpetas por faceta |
| Detectar y manejar 429 con backoff exponencial         | ✅ `retry-policy.ts` |
| Continuar con el siguiente si el error persiste        | ✅ cola de fallidos, no aborta |
| Registrar documentos fallidos para reintentar          | ✅ `failed.ndjson` + `resumeFailedDownloads` |
| Delays entre requests                                  | ✅ `delayBetweenRequests` + throttle |
| Datos en formato estructurado (JSON)                   | ✅ NDJSON + JSON agregado |
| Logging de progreso                                    | ✅ `logger.ts` (consola + archivo) |
| Subconjunto de páginas en desarrollo                   | ✅ `executionMode` |
| README + `.gitignore` + scripts                        | ✅ |
