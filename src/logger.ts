import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Determine log directory based on OS and permissions
function getLogDirectory(): string {
  const defaultLogDir = '/var/log';
  const userLogDir = path.join(os.homedir(), '.lens-node', 'logs');
  
  // Try to use /var/log if we have write permissions
  try {
    fs.accessSync(defaultLogDir, fs.constants.W_OK);
    return defaultLogDir;
  } catch {
    // Fallback to user directory
    fs.mkdirSync(userLogDir, { recursive: true });
    return userLogDir;
  }
}

const logDir = getLogDirectory();
const logFile = path.join(logDir, 'rifflens.log');

// Create custom format
const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let msg = `${timestamp} [${level.toUpperCase()}] ${message}`;
    
    // Add metadata if present
    if (Object.keys(metadata).length > 0) {
      // Filter out error stack from metadata to avoid duplication
      const { stack, ...cleanMetadata } = metadata;
      if (Object.keys(cleanMetadata).length > 0) {
        msg += ` ${JSON.stringify(cleanMetadata)}`;
      }
      if (stack) {
        msg += `\n${stack}`;
      }
    }
    
    return msg;
  })
);

// Configure daily rotate transport
const dailyRotateTransport = new DailyRotateFile({
  filename: path.join(logDir, 'rifflens-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
  format: customFormat,
});

// Create a symlink to the latest log file
dailyRotateTransport.on('new', (newFilename) => {
  try {
    // Remove existing symlink if it exists
    if (fs.existsSync(logFile)) {
      fs.unlinkSync(logFile);
    }
    // Create new symlink
    fs.symlinkSync(newFilename, logFile);
  } catch (error) {
    // Ignore symlink errors (might not have permissions)
  }
});

// Create logger instance
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: customFormat,
  transports: [
    // Console transport
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        customFormat
      ),
    }),
    // File transport with rotation
    dailyRotateTransport,
  ],
});

// Log startup information
logger.info('Lens Node logger initialized', {
  logDirectory: logDir,
  logFile: logFile,
  pid: process.pid,
  nodeVersion: process.version,
});

// Helper functions for structured logging
export function logSubscriptionEvent(event: string, data: any) {
  logger.info(`Subscription Event: ${event}`, {
    event,
    ...data,
    timestamp: new Date().toISOString(),
  });
}

export function logSyncEvent(event: string, data: any) {
  logger.info(`Sync Event: ${event}`, {
    event,
    ...data,
    timestamp: new Date().toISOString(),
  });
}

export function logPeerEvent(event: string, data: any) {
  logger.debug(`Peer Event: ${event}`, {
    event,
    ...data,
    timestamp: new Date().toISOString(),
  });
}

export function logError(message: string, error: any, context?: any) {
  logger.error(message, {
    error: error?.message || error,
    stack: error?.stack,
    ...context,
  });
}

export default logger;