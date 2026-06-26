/**
 * Utilidades puras para tratar con JSF (Mojarra) + RichFaces.
 *
 * Todo lo que aquí se parsea está basado en la estructura HTTP/HTML real del sitio
 * (ver SPEC.md). Estas funciones no tienen estado ni hacen I/O: reciben HTML/XML
 * y devuelven datos, lo que las hace fáciles de testear con fixtures.
 */

import * as cheerio from 'cheerio';

/** Par nombre→valor de un campo de formulario. */
export type FormField = [name: string, value: string];

/** Extrae el `javax.faces.ViewState` de una página HTML completa. */
export function extractViewStateFromHtml(html: string): string | null {
  const $ = cheerio.load(html);
  const value = $('input[name="javax.faces.ViewState"]').attr('value');
  return value ?? null;
}

/** Extrae el `javax.faces.ViewState` actualizado de una respuesta parcial (text/xml). */
export function extractViewStateFromPartial(xml: string): string | null {
  const match = xml.match(
    /<update id="(?:[^"]*:)?javax\.faces\.ViewState[^"]*"><!\[CDATA\[([\s\S]*?)\]\]><\/update>/,
  );
  return match ? (match[1] ?? null) : null;
}

/** Devuelve el contenido (CDATA) de un `<update id="...">` de una respuesta parcial. */
export function extractPartialUpdate(xml: string, updateId: string): string | null {
  const escaped = updateId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<update id="${escaped}"><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></update>`));
  return match ? (match[1] ?? null) : null;
}

/**
 * Serializa los campos "exitosos" del formulario `formBuscador` de una página.
 * Excluye botones (submit/image/reset/button), checkboxes/radios no marcados y el
 * propio ViewState (que se gestiona aparte porque rota en cada respuesta).
 */
export function serializeForm(html: string): FormField[] {
  const $ = cheerio.load(html);
  const fields: FormField[] = [];

  $('input').each((_, el) => {
    const name = $(el).attr('name');
    if (!name || name === 'javax.faces.ViewState') return;
    const type = ($(el).attr('type') ?? 'text').toLowerCase();
    if (['submit', 'image', 'reset', 'button'].includes(type)) return;
    if ((type === 'checkbox' || type === 'radio') && $(el).attr('checked') === undefined) return;
    fields.push([name, $(el).attr('value') ?? '']);
  });

  $('select').each((_, el) => {
    const name = $(el).attr('name');
    if (!name) return;
    const selected = $(el).find('option[selected]').attr('value');
    const fallback = $(el).find('option').first().attr('value');
    fields.push([name, selected ?? fallback ?? '']);
  });

  $('textarea').each((_, el) => {
    const name = $(el).attr('name');
    if (!name) return;
    fields.push([name, $(el).text() ?? '']);
  });

  return fields;
}

/**
 * Codifica un cuerpo de formulario (application/x-www-form-urlencoded) a partir de
 * los campos base, parámetros extra y el ViewState actual. El orden de inserción
 * se preserva; los valores se URL-encodean correctamente (acentos, `/`, `:` ...).
 */
export function encodeForm(
  baseFields: FormField[],
  extraParams: Record<string, string>,
  viewState: string,
): string {
  const params = new URLSearchParams();
  for (const [name, value] of baseFields) params.append(name, value);
  for (const [name, value] of Object.entries(extraParams)) params.append(name, value);
  params.append('javax.faces.ViewState', viewState);
  return params.toString();
}

/**
 * Descodifica los parámetros de un `onclick` de RichFaces.ajax (botón "Ficha").
 * El atributo viene doblemente escapado (HTML + JS). Devuelve el clientId fuente y
 * el mapa de parámetros (uuid, recurso, nroexp, ...).
 */
export function decodeRichFacesAjax(
  onclickRaw: string,
): { sourceId: string; params: Record<string, string> } | null {
  // cheerio ya descodifica entidades HTML al leer el atributo; resta desescapar JS.
  const normalized = onclickRaw
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\+\//g, '/')
    .replace(/\\+"/g, '"');

  const sourceMatch = normalized.match(/RichFaces\.ajax\("([^"]+)"/);
  if (!sourceMatch) return null;
  const sourceId = sourceMatch[1] as string;

  const params = extractJsonObject(normalized, '"parameters":');
  if (!params) return null;

  // Solo nos interesan los valores string del objeto parameters.
  const stringParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') stringParams[k] = v;
  }
  return { sourceId, params: stringParams };
}

/**
 * Descubre el botón de búsqueda ESPECIALIZADA en `inicio.xhtml` y sus parámetros
 * sintéticos. Los ids `j_idtNN` son autogenerados por JSF (cambian si recompilan
 * la vista), por eso NO se hardcodean: se descubren parseando el `mojarra.jsfcljs`.
 *
 * Hay dos botones "Buscar" con `forward=buscar`: el general (incluye
 * `busqueda=especializada`) y el especializado (sin `busqueda`). Elegimos el
 * especializado, que es el que opera sobre los filtros estructurados (corte/año).
 */
export function discoverSearchButton(html: string): Record<string, string> | null {
  const $ = cheerio.load(html);
  const candidates: Record<string, string>[] = [];

  $('[onclick*="mojarra.jsfcljs"]').each((_, el) => {
    const onclick = $(el).attr('onclick') ?? '';
    const normalized = onclick.replace(/\\'/g, "'");
    const params = extractSingleQuotedObject(normalized, "mojarra.jsfcljs(document.getElementById('formBuscador'),");
    if (params && params['forward'] === 'buscar') candidates.push(params);
  });

  if (candidates.length === 0) return null;
  const especializado = candidates.find((p) => !('busqueda' in p));
  return especializado ?? candidates[0] ?? null;
}

/** Concatena el HTML de todos los bloques CDATA de una respuesta parcial (text/xml). */
export function extractAllCdata(xml: string): string {
  const blocks: string[] = [];
  const regex = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    if (match[1]) blocks.push(match[1]);
  }
  return blocks.join('\n');
}

/**
 * Aplica overrides a una lista de campos: reemplaza el valor de los nombres que ya
 * existen y añade los que falten. Evita claves duplicadas en el cuerpo del POST.
 */
export function applyOverrides(fields: FormField[], overrides: Record<string, string>): FormField[] {
  const seen = new Set<string>();
  const result: FormField[] = fields.map(([name, value]) => {
    if (name in overrides) {
      seen.add(name);
      return [name, overrides[name] as string];
    }
    return [name, value];
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (!seen.has(name)) result.push([name, value]);
  }
  return result;
}

/** Extrae los años disponibles del selector `buAnio` de inicio.xhtml (desc). */
export function parseAvailableYears(html: string): number[] {
  const $ = cheerio.load(html);
  const years = new Set<number>();
  $('select[name="formBuscador:buAnio"] option').each((_, el) => {
    const value = Number($(el).attr('value'));
    if (Number.isInteger(value) && value > 1900) years.add(value);
  });
  return [...years].sort((a, b) => b - a);
}

/** Lee "se obtuvieron N resultados" de la página de resultados. */
export function parseTotalResults(html: string): number | null {
  const match = html.match(/se\s+obtuvieron\s+([\d.,]+)\s+resultados/i);
  if (!match) return null;
  const digits = (match[1] ?? '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

// ─────────────────────────── Helpers internos ───────────────────────────

/**
 * Extrae el objeto JSON que sigue a `marker` mediante emparejamiento de llaves,
 * y lo parsea. Robusto frente a valores que contengan comas o dos puntos.
 */
function extractJsonObject(text: string, marker: string): Record<string, unknown> | null {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const braceStart = text.indexOf('{', start + marker.length);
  if (braceStart < 0) return null;
  const body = sliceBalancedBraces(text, braceStart);
  if (!body) return null;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Igual que `extractJsonObject` pero para objetos con comillas simples. */
function extractSingleQuotedObject(text: string, marker: string): Record<string, string> | null {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const braceStart = text.indexOf('{', start + marker.length);
  if (braceStart < 0) return null;
  const body = sliceBalancedBraces(text, braceStart);
  if (!body) return null;
  // Claves/valores no contienen comillas embebidas → conversión directa a JSON.
  try {
    return JSON.parse(body.replace(/'/g, '"')) as Record<string, string>;
  } catch {
    return null;
  }
}

/** Devuelve el substring `{...}` balanceado que empieza en `openIdx`. */
function sliceBalancedBraces(text: string, openIdx: number): string | null {
  let depth = 0;
  let inString = false;
  let quote = '';
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      if (ch === '\\') {
        i++; // saltar el carácter escapado
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return null;
}
