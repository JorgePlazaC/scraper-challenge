/**
 * Cola de documentos/descargas fallidas.
 *
 * Cumple el requisito de "registrar qué documentos fallaron para reintentarlos
 * después". Se persiste como NDJSON en state/failed.ndjson.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FailedEntry } from '../types';

export class FailedQueue {
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'failed.ndjson');
    fs.mkdirSync(stateDir, { recursive: true });
  }

  add(entry: FailedEntry): void {
    fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
  }

  loadAll(): FailedEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    const content = fs.readFileSync(this.filePath, 'utf-8');
    const entries: FailedEntry[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as FailedEntry);
      } catch {
        // línea corrupta: ignorar
      }
    }
    return entries;
  }

  /** Reescribe la cola con las entradas que siguen pendientes (tras reintentos). */
  replaceAll(entries: FailedEntry[]): void {
    const body = entries.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(this.filePath, body ? body + '\n' : '');
  }

  get count(): number {
    return this.loadAll().length;
  }
}
