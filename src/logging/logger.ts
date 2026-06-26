/**
 * Logger estructurado por niveles.
 *
 * Escribe a consola (legible para humanos) y, opcionalmente, a un archivo
 * (una línea JSON por evento, apto para análisis posterior).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { LogLevel } from '../types';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m', // gris
  info: '\x1b[36m', // cian
  warn: '\x1b[33m', // amarillo
  error: '\x1b[31m', // rojo
};
const RESET = '\x1b[0m';

export class Logger {
  private readonly minWeight: number;
  private readonly fileStream: fs.WriteStream | null;

  constructor(level: LogLevel, logFilePath?: string) {
    this.minWeight = LEVEL_WEIGHT[level];
    this.fileStream = null;
    if (logFilePath) {
      fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
      this.fileStream = fs.createWriteStream(logFilePath, { flags: 'a' });
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }
  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }
  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }
  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context);
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < this.minWeight) return;

    const timestamp = new Date().toISOString();

    // Consola (legible)
    const ctxText =
      context && Object.keys(context).length > 0 ? ' ' + JSON.stringify(context) : '';
    const time = timestamp.slice(11, 19);
    process.stdout.write(
      `${LEVEL_COLOR[level]}${time} ${level.toUpperCase().padEnd(5)}${RESET} ${message}${ctxText}\n`,
    );

    // Archivo (JSON por línea)
    if (this.fileStream) {
      this.fileStream.write(JSON.stringify({ timestamp, level, message, ...context }) + '\n');
    }
  }

  close(): void {
    this.fileStream?.end();
  }
}
