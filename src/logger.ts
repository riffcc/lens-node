import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// (getLogDirectory function remains the same)
function getLogDirectory(): string {
  const appName = 'rifflens';
  const systemLogDir = path.join('/var/log', appName);
  const userLogDir = path.join(os.homedir(), '.lens-node', 'logs');

  try {
    if (!fs.existsSync(systemLogDir)) {
      fs.mkdirSync(systemLogDir, { recursive: true });
    }
    fs.accessSync(systemLogDir, fs.constants.W_OK);
    console.log(`Logging to system directory: ${systemLogDir}`);
    return systemLogDir;
  } catch {
    if (!fs.existsSync(userLogDir)) {
      fs.mkdirSync(userLogDir, { recursive: true });
    }
    console.log(`Could not write to /var/log. Logging to user directory: ${userLogDir}`);
    return userLogDir;
  }
}


const logDir = getLogDirectory();
const logFile = path.join(logDir, 'rifflens-latest.log');

// FIX: Define the printf function once to be reused.
const myPrintf = winston.format.printf(({ timestamp, level, message, stack, ...metadata }) => {
  let msg = `${timestamp} [${level}] ${message}`; // No need for .toUpperCase(), colorize handles it.

  if (Object.keys(metadata).length > 0) {
    msg += `\n${JSON.stringify(metadata, null, 2)}`;
  }
  
  if (stack) {
    msg += `\n${stack}`;
  }
  
  return msg;
});

// FIX: Create a dedicated format for file transports.
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  myPrintf // Use the reusable printf
);

// FIX: Create a dedicated format for the console transport.
const consoleFormat = winston.format.combine(
  winston.format.colorize(), // This is the key difference
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  myPrintf // Use the reusable printf
);


// Configure daily rotate transport
const dailyRotateTransport = new DailyRotateFile({
  filename: path.join(logDir, 'rifflens-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
});

// (symlink logic remains the same)
dailyRotateTransport.on('rotate', (oldFilename, newFilename) => {
  try {
    if (fs.existsSync(logFile)) {
      fs.unlinkSync(logFile);
    }
    fs.symlinkSync(newFilename, logFile, 'file');
  } catch (error) {
    console.error('Could not create symlink for log file.', error);
  }
});

// Create logger instance
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  // FIX: Set the default format to the file format.
  format: fileFormat,
  transports: [
    // Console transport
    new winston.transports.Console({
      // FIX: Use the explicit format we created for the console.
      format: consoleFormat,
    }),
    // File transport with rotation
    dailyRotateTransport,
  ],
  // (exception/rejection handlers remain the same)
  exceptionHandlers: [
    new winston.transports.File({ filename: path.join(logDir, 'exceptions.log') })
  ],
  rejectionHandlers: [
    new winston.transports.File({ filename: path.join(logDir, 'rejections.log') })
  ],
  exitOnError: false, 
});


// (Helper functions remain the same)
export function logSubscriptionEvent(event: string, data: any) {
  logger.info(`Subscription Event: ${event}`, { event, ...data });
}

export function logSyncEvent(event: string, data: any) {
  logger.info(`Sync Event: ${event}`, { event, ...data });
}

export function logPeerEvent(event: string, data: any) {
  logger.debug(`Peer Event: ${event}`, { event, ...data });
}

export function logError(message: string, error: any, context?: any) {
  logger.error(message, { error, ...context });
}

export default logger;