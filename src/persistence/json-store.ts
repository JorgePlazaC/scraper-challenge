/**
 * Persistencia de los documentos extraídos.
 *
 * Estrategia: NDJSON incremental (una línea por documento, escrita en cuanto se
 * procesa) → resiliente ante caídas y reanudable a gran escala. Al finalizar se
 * genera además un JSON agregado para consumo cómodo.
 *
 * Deduplica por uuid (cargando los ya existentes al iniciar), de modo que una
 * reanudación no duplica documentos aunque se reprocese una página parcialmente.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DocumentRecord } from '../types';

export class JsonStore {
  private readonly ndjsonPath: string;
  private readonly aggregatedPath: string;
  private readonly seen = new Set<string>();

  constructor(dataDir: string) {
    this.ndjsonPath = path.join(dataDir, 'documents.ndjson');
    this.aggregatedPath = path.join(dataDir, 'documents.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.loadExistingUuids();
  }

  /** ¿Ya se ha persistido este documento? */
  has(uuid: string): boolean {
    return this.seen.has(uuid);
  }

  get size(): number {
    return this.seen.size;
  }

  /** Añade un documento (NDJSON). Devuelve false si era duplicado. */
  append(doc: DocumentRecord): boolean {
    if (this.seen.has(doc.uuid)) return false;
    fs.appendFileSync(this.ndjsonPath, JSON.stringify(doc) + '\n');
    this.seen.add(doc.uuid);
    return true;
  }

  /** Reconstruye el JSON agregado a partir del NDJSON. */
  finalizeAggregate(): number {
    if (!fs.existsSync(this.ndjsonPath)) {
      fs.writeFileSync(this.aggregatedPath, '[]\n');
      return 0;
    }
    const docs = this.readAll();
    fs.writeFileSync(this.aggregatedPath, JSON.stringify(docs, null, 2) + '\n');
    return docs.length;
  }

  /** Carga todos los documentos persistidos (uso puntual, p.ej. reconciliación final). */
  loadAllDocs(): DocumentRecord[] {
    return this.readAll();
  }

  /** Reescribe el NDJSON completo (reconciliación al final del run, no en caliente). */
  rewriteAll(docs: DocumentRecord[]): void {
    const body = docs.map((d) => JSON.stringify(d)).join('\n');
    fs.writeFileSync(this.ndjsonPath, body ? body + '\n' : '');
    this.seen.clear();
    for (const d of docs) this.seen.add(d.uuid);
  }

  private readAll(): DocumentRecord[] {
    const content = fs.readFileSync(this.ndjsonPath, 'utf-8');
    const docs: DocumentRecord[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        docs.push(JSON.parse(trimmed) as DocumentRecord);
      } catch {
        // Línea corrupta (p.ej. corte abrupto): se ignora sin abortar.
      }
    }
    return docs;
  }

  private loadExistingUuids(): void {
    if (!fs.existsSync(this.ndjsonPath)) return;
    for (const doc of this.readAll()) this.seen.add(doc.uuid);
  }
}
