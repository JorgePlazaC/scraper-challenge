/**
 * Orquestador: coordina el flujo de alto nivel y delega los detalles HTTP/parsing.
 *
 *   facetas (Corte × Año) → páginas → documentos → ficha (modal) → PDF
 *
 * Responsabilidades transversales:
 *  - Reanudación por checkpoint (faceta/página) + deduplicación por uuid.
 *  - Continuidad ante fallos parciales (ficha/PDF) sin abortar el lote.
 *  - Concurrencia controlada en descargas de PDF; resto secuencial (por el ViewState).
 */

import * as path from 'path';
import { PAGE_SIZE, type Config } from '../config';
import type { Logger } from '../logging/logger';
import type { JsfSession } from '../http/jsf-session';
import type { SearchClient } from '../scraping/search-client';
import type { FichaClient } from '../scraping/ficha-client';
import type { PdfDownloader } from '../scraping/pdf-downloader';
import type { JsonStore } from '../persistence/json-store';
import type { FailedQueue } from '../persistence/failed-queue';
import type { Checkpoint } from '../persistence/checkpoint';
import type { DocumentRecord, Facet, Ficha, PdfInfo, RowSummary } from '../types';
import { buildSearchSpace, maxPagesForMode } from './search-space';
import { mapWithConcurrency } from '../utils/async';

export interface OrchestratorDeps {
  session: JsfSession;
  searchClient: SearchClient;
  fichaClient: FichaClient;
  pdfDownloader: PdfDownloader;
  jsonStore: JsonStore;
  failedQueue: FailedQueue;
  checkpoint: Checkpoint;
  pdfsDir: string;
  outputDir: string;
}

export class Orchestrator {
  private readonly stats = {
    facets: 0,
    pages: 0,
    documents: 0,
    pdfsOk: 0,
    pdfsFailed: 0,
    pdfsSkipped: 0,
    fichasFailed: 0,
  };

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly deps: OrchestratorDeps,
  ) {}

  async run(): Promise<void> {
    const startedAt = Date.now();
    this.logger.info('═══ Scraper de Jurisprudencia (PJ Perú) ═══');
    this.logConfig();

    const inicioHtml = await this.deps.session.bootstrap();
    const facets = buildSearchSpace(this.config, this.deps.session.availableYears);
    this.logger.info(`Espacio de búsqueda: ${facets.length} faceta(s) en modo ${this.config.executionMode}`);

    for (let i = 0; i < facets.length; i++) {
      const facet = facets[i] as Facet;
      await this.processFacet(facet, i === 0 ? inicioHtml : undefined);
    }

    if (this.config.resumeFailedDownloads) await this.retryFailedDownloads();

    const aggregated = this.deps.jsonStore.finalizeAggregate();
    this.logSummary(startedAt, aggregated);
  }

  // ─────────────────────────── Faceta ───────────────────────────

  private async processFacet(facet: Facet, inicioHtml?: string): Promise<void> {
    const key = `${facet.corte}-${facet.anio}`;
    if (this.deps.checkpoint.isFacetDone(key)) {
      this.logger.info(`Faceta ${facet.corteNombre}/${facet.anio} ya completada — se omite`);
      return;
    }

    let search;
    try {
      search = await this.deps.searchClient.search(facet, inicioHtml);
    } catch (error) {
      this.logger.error(`Búsqueda fallida en ${facet.corteNombre}/${facet.anio}`, {
        error: (error as Error).message,
      });
      return;
    }

    this.stats.facets += 1;
    const total = search.total ?? 0;
    const totalPages = total > 0 ? Math.ceil(total / PAGE_SIZE) : search.rows.length > 0 ? Infinity : 0;
    const lastPage = Math.min(maxPagesForMode(this.config.executionMode), totalPages);

    this.logger.info(`Faceta ${facet.corteNombre}/${facet.anio}`, {
      totalResultados: total,
      paginasTotales: Number.isFinite(totalPages) ? totalPages : 'desconocidas',
      paginasAProcesar: Number.isFinite(lastPage) ? lastPage : 'hasta fin',
    });

    const startPage = Math.max(1, this.deps.checkpoint.lastPage(key) + 1);
    for (let page = startPage; page <= lastPage; page++) {
      const rows = page === 1 ? search.rows : await this.safeGoToPage(facet, page, key);
      if (rows === null) break; // fallo de paginación: cortamos esta faceta
      if (rows.length === 0) {
        this.logger.warn(`Página ${page} vacía — fin de la faceta`);
        break;
      }

      await this.processPage(facet, page, rows);
      this.deps.checkpoint.savePage(key, page);
      this.stats.pages += 1;
    }

    // Marcamos la faceta como completada solo si se recorrieron todas sus páginas.
    if (Number.isFinite(totalPages) && lastPage >= totalPages) {
      this.deps.checkpoint.markFacetDone(key);
    }
  }

  private async safeGoToPage(facet: Facet, page: number, key: string): Promise<RowSummary[] | null> {
    try {
      return await this.deps.searchClient.goToPage(page);
    } catch (error) {
      this.logger.error(`Fallo paginando a p${page} en ${facet.corteNombre}/${facet.anio}`, {
        error: (error as Error).message,
      });
      this.deps.failedQueue.add({
        uuid: `page-${key}-${page}`,
        nroExpediente: null,
        stage: 'page',
        reason: (error as Error).message,
        facet: { corte: facet.corte, anio: facet.anio },
        page,
        pdfUrl: null,
        failedAt: new Date().toISOString(),
      });
      return null;
    }
  }

  // ─────────────────────────── Página ───────────────────────────

  private async processPage(facet: Facet, page: number, rows: RowSummary[]): Promise<void> {
    // 1) Ficha por documento (secuencial: el ViewState es compartido y rota).
    const pending: { doc: DocumentRecord; row: RowSummary }[] = [];
    for (const row of rows) {
      if (this.deps.jsonStore.has(row.uuid)) {
        this.logger.debug(`Documento ${row.uuid} ya guardado — se omite`);
        continue;
      }

      let ficha: Ficha | null = null;
      if (this.config.fetchFichaModal) {
        try {
          ficha = await this.deps.fichaClient.fetch(row);
        } catch (error) {
          this.stats.fichasFailed += 1;
          this.logger.warn(`Ficha fallida (${row.nroExpediente})`, { error: (error as Error).message });
          this.deps.failedQueue.add({
            uuid: row.uuid,
            nroExpediente: row.nroExpediente,
            stage: 'ficha',
            reason: (error as Error).message,
            facet: { corte: facet.corte, anio: facet.anio },
            page,
            pdfUrl: this.deps.pdfDownloader.buildUrl(row.uuid),
            failedAt: new Date().toISOString(),
          });
        }
      }

      pending.push({ doc: this.buildDocument(facet, page, row, ficha), row });
    }

    // 2) Descarga de PDFs (concurrente; GET independiente del ViewState).
    if (this.config.downloadPdfs) {
      await mapWithConcurrency(pending, this.config.concurrentPdfDownloads, async ({ doc, row }) => {
        await this.downloadPdf(facet, page, doc, row);
      });
    }

    // 3) Persistencia (tras conocer el estado final del PDF).
    for (const { doc } of pending) {
      if (this.deps.jsonStore.append(doc)) this.stats.documents += 1;
    }
    this.logger.info(`Página ${page} de ${facet.corteNombre}/${facet.anio}: ${pending.length} documento(s)`);
  }

  private async downloadPdf(
    facet: Facet,
    page: number,
    doc: DocumentRecord,
    row: RowSummary,
  ): Promise<void> {
    const dest = this.pdfDest(facet.corteNombre, facet.anio, row.uuid);
    try {
      const result = await this.deps.pdfDownloader.download(row.uuid, dest);
      doc.pdf = {
        ...doc.pdf,
        serverFilename: result.serverFilename,
        localPath: this.relPath(dest),
        status: 'downloaded',
        bytes: result.bytes,
        sha256: result.sha256,
        attempts: doc.pdf.attempts + 1,
        error: null,
      };
      this.stats.pdfsOk += 1;
    } catch (error) {
      doc.pdf = { ...doc.pdf, status: 'failed', attempts: doc.pdf.attempts + 1, error: (error as Error).message };
      this.stats.pdfsFailed += 1;
      this.logger.warn(`PDF fallido (${row.nroExpediente})`, { error: (error as Error).message });
      this.deps.failedQueue.add({
        uuid: row.uuid,
        nroExpediente: row.nroExpediente,
        stage: 'pdf',
        reason: (error as Error).message,
        facet: { corte: facet.corte, anio: facet.anio },
        page,
        pdfUrl: this.deps.pdfDownloader.buildUrl(row.uuid),
        failedAt: new Date().toISOString(),
      });
    }
  }

  // ─────────────────────────── Reintento de fallidos ───────────────────────────

  private async retryFailedDownloads(): Promise<void> {
    const all = this.deps.failedQueue.loadAll();
    const pdfFailures = [...new Map(all.filter((e) => e.stage === 'pdf').map((e) => [e.uuid, e])).values()];
    if (pdfFailures.length === 0) {
      this.logger.info('No hay descargas pendientes en la cola de fallidos');
      return;
    }

    this.logger.info(`Reintentando ${pdfFailures.length} descarga(s) de la cola de fallidos`);
    const docs = this.deps.jsonStore.loadAllDocs();
    const byUuid = new Map(docs.map((d) => [d.uuid, d]));
    const remaining = all.filter((e) => e.stage !== 'pdf');
    let recovered = 0;

    await mapWithConcurrency(pdfFailures, this.config.concurrentPdfDownloads, async (entry) => {
      const doc = byUuid.get(entry.uuid);
      if (!doc) return;
      const dest = this.pdfDest(doc.corte, doc.anio, doc.uuid);
      try {
        const result = await this.deps.pdfDownloader.download(doc.uuid, dest);
        doc.pdf = {
          ...doc.pdf,
          serverFilename: result.serverFilename,
          localPath: this.relPath(dest),
          status: 'downloaded',
          bytes: result.bytes,
          sha256: result.sha256,
          attempts: doc.pdf.attempts + 1,
          error: null,
        };
        recovered += 1;
      } catch (error) {
        doc.pdf = { ...doc.pdf, attempts: doc.pdf.attempts + 1, error: (error as Error).message };
        remaining.push(entry);
      }
    });

    this.deps.jsonStore.rewriteAll([...byUuid.values()]);
    this.deps.failedQueue.replaceAll(remaining);
    this.stats.pdfsOk += recovered;
    this.stats.pdfsFailed -= recovered;
    this.logger.info(`Recuperadas ${recovered}/${pdfFailures.length} descargas`);
  }

  // ─────────────────────────── Helpers ───────────────────────────

  private buildDocument(facet: Facet, page: number, row: RowSummary, ficha: Ficha | null): DocumentRecord {
    const pdf: PdfInfo = {
      downloadUrl: this.deps.pdfDownloader.buildUrl(row.uuid),
      serverFilename: null,
      localPath: null,
      status: this.config.downloadPdfs ? 'pending' : 'skipped',
      bytes: null,
      sha256: null,
      attempts: 0,
      error: null,
    };
    if (!this.config.downloadPdfs) this.stats.pdfsSkipped += 1;

    return {
      uuid: row.uuid,
      nroExpediente: row.nroExpediente,
      recurso: row.recurso,
      tipoResolucion: row.tipoResolucion,
      fechaResolucion: row.fechaResolucion,
      sala: row.sala,
      corte: facet.corteNombre,
      anio: facet.anio,
      pretensiones: row.pretensiones,
      palabrasClave: row.palabrasClave,
      normaDerechoInterno: row.normaDerechoInterno,
      sumilla: row.sumilla,
      ficha,
      pdf,
      _meta: {
        facet: { corte: facet.corte, anio: facet.anio },
        page,
        rowIndex: row.rowIndex,
        scrapedAt: new Date().toISOString(),
      },
    };
  }

  private pdfDest(corteNombre: string, anio: number, uuid: string): string {
    return path.join(this.deps.pdfsDir, corteNombre, String(anio), `${uuid}.pdf`);
  }

  private relPath(absolute: string): string {
    return path.relative(this.deps.outputDir, absolute).split(path.sep).join('/');
  }

  private logConfig(): void {
    this.logger.info('Configuración', {
      modo: this.config.executionMode,
      facetaRef: this.config.referenceFacet,
      delayMs: this.config.delayBetweenRequests,
      maxRetries429: this.config.maxRetries429,
      descargarPdfs: this.config.downloadPdfs,
      concurrenciaPdf: this.config.concurrentPdfDownloads,
      ficha: this.config.fetchFichaModal,
    });
  }

  private logSummary(startedAt: number, aggregated: number): void {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    this.logger.info('═══ Resumen ═══', {
      duracionSeg: Number(seconds),
      facetas: this.stats.facets,
      paginas: this.stats.pages,
      documentosNuevos: this.stats.documents,
      pdfsOk: this.stats.pdfsOk,
      pdfsFallidos: this.stats.pdfsFailed,
      pdfsOmitidos: this.stats.pdfsSkipped,
      fichasFallidas: this.stats.fichasFailed,
      totalEnDataset: aggregated,
    });
  }
}
