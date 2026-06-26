/**
 * Punto de entrada (composition root).
 *
 * Aquí —y solo aquí— se construyen e inyectan las dependencias. El resto del
 * código depende de abstracciones, no de instancias concretas, lo que mantiene
 * cada módulo testeable de forma aislada.
 *
 * El comportamiento se controla íntegramente desde `config.ts` (sin argumentos de
 * consola ni interfaces interactivas).
 */

import * as path from 'path';
import { config } from './config';
import { Logger } from './logging/logger';
import { HttpClient } from './http/http-client';
import { RetryPolicy } from './http/retry-policy';
import { JsfSession } from './http/jsf-session';
import { SearchClient } from './scraping/search-client';
import { FichaClient } from './scraping/ficha-client';
import { PdfDownloader } from './scraping/pdf-downloader';
import { JsonStore } from './persistence/json-store';
import { FailedQueue } from './persistence/failed-queue';
import { Checkpoint } from './persistence/checkpoint';
import { Orchestrator } from './core/orchestrator';

async function main(): Promise<void> {
  // Estructura de carpetas de salida.
  const outputDir = path.resolve(config.outputDirectory);
  const dataDir = path.join(outputDir, 'data');
  const pdfsDir = path.join(outputDir, 'pdfs');
  const stateDir = path.join(outputDir, 'state');
  const logsDir = path.join(outputDir, 'logs');
  const logFile = path.join(logsDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

  const logger = new Logger(config.logLevel, logFile);

  // Cableado de dependencias.
  const http = new HttpClient(config);
  const retry = new RetryPolicy(config, logger);
  const session = new JsfSession(http, retry, config, logger);
  const searchClient = new SearchClient(http, retry, config, logger, session);
  const fichaClient = new FichaClient(http, retry, config, session);
  const pdfDownloader = new PdfDownloader(http, retry, config);
  const jsonStore = new JsonStore(dataDir);
  const failedQueue = new FailedQueue(stateDir);
  const checkpoint = new Checkpoint(stateDir);

  const orchestrator = new Orchestrator(config, logger, {
    session,
    searchClient,
    fichaClient,
    pdfDownloader,
    jsonStore,
    failedQueue,
    checkpoint,
    pdfsDir,
    outputDir,
  });

  try {
    await orchestrator.run();
  } catch (error) {
    logger.error('Error fatal no recuperado', {
      error: (error as Error).message,
      stack: (error as Error).stack,
    });
    process.exitCode = 1;
  } finally {
    logger.close();
  }
}

void main();
