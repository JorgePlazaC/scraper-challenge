/**
 * Checkpoint de reanudación.
 *
 * Guarda, por faceta (Corte × Año), la última página completada y si la faceta
 * quedó terminada. Permite reanudar sin reprocesar facetas/páginas completas.
 * Combinado con la deduplicación por uuid de JsonStore, el recorrido es idempotente.
 */

import * as fs from 'fs';
import * as path from 'path';

interface FacetProgress {
  lastPage: number;
  done: boolean;
}

interface CheckpointData {
  facets: Record<string, FacetProgress>;
}

export class Checkpoint {
  private readonly filePath: string;
  private data: CheckpointData;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'checkpoint.json');
    fs.mkdirSync(stateDir, { recursive: true });
    this.data = this.load();
  }

  static key(corte: number, anio: number): string {
    return `${corte}-${anio}`;
  }

  isFacetDone(key: string): boolean {
    return this.data.facets[key]?.done ?? false;
  }

  lastPage(key: string): number {
    return this.data.facets[key]?.lastPage ?? 0;
  }

  savePage(key: string, page: number): void {
    const current = this.data.facets[key] ?? { lastPage: 0, done: false };
    current.lastPage = Math.max(current.lastPage, page);
    this.data.facets[key] = current;
    this.persist();
  }

  markFacetDone(key: string): void {
    const current = this.data.facets[key] ?? { lastPage: 0, done: false };
    current.done = true;
    this.data.facets[key] = current;
    this.persist();
  }

  private load(): CheckpointData {
    if (!fs.existsSync(this.filePath)) return { facets: {} };
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as CheckpointData;
    } catch {
      return { facets: {} };
    }
  }

  private persist(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}
