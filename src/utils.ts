import path from 'node:path';
import os from 'node:os';
import { CONFIG_FILE_NAME, DEFAULT_NODE_DIR } from './constants.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { SiteConfig } from './types.js';
import Ajv, { JSONSchemaType } from 'ajv';

export function getDefaultDir() {
  const homeDir = os.homedir();
  const nodeDir = path.join(homeDir, DEFAULT_NODE_DIR);
  return nodeDir;
}

export function saveConfig(config: SiteConfig, dir: string) {
  const configPath = path.join(dir, CONFIG_FILE_NAME)
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

export function readConfig(dir: string): SiteConfig {
  const siteConfigSchema: JSONSchemaType<SiteConfig> = {
    type: 'object',
    properties: {
      address: { type: 'string', minLength: 1 },
    },
    required: ['address'],
    additionalProperties: false,
  };
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(siteConfigSchema);
  try {

    const configPath = path.join(dir, CONFIG_FILE_NAME);
    const configData = readFileSync(configPath, 'utf8');

    const config: SiteConfig = JSON.parse(configData);

    if (!validate(config)) {
      const errors = validate.errors?.map(err =>
        `${err.instancePath || 'config'}${err.message}`
      ).join('; ');
      throw new Error(`Invalid configuration: ${errors}`);
    }

    return config;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to read config: ${error.message}`);
    }
    throw new Error('Failed to read config: Unknown error');
  }
}