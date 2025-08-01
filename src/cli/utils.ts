import path from 'node:path';
import os from 'node:os';
import fs, { readFileSync, writeFileSync } from 'node:fs';
import confirm from "@inquirer/confirm";
import Ajv, { JSONSchemaType } from 'ajv';
import { CONFIG_FILE_NAME, DEFAULT_NODE_DIR } from './constants.js';
import { SiteConfig } from './types.js';
import { categoriesFileSchema, type ContentCategoryData, type ContentCategoryMetadataField } from '@riffcc/lens-sdk';


export function getDefaultDir() {
  const homeDir = os.homedir();
  const nodeDir = path.join(homeDir, DEFAULT_NODE_DIR);
  return nodeDir;
}

export async function handleDirectorySetup(directory: string, commandName: string): Promise<boolean> {
  if (fs.existsSync(directory)) {
    const overwrite = await confirm({
      message: `The node directory "${directory}" already exists. Do you want to reconfigure for ${commandName}? This action is irreversible.`,
      default: false,
    });

    if (overwrite) {
      fs.rmSync(directory, { recursive: true, force: true });
      fs.mkdirSync(directory, { recursive: true });
      console.log(`Node directory cleared and ready for new configuration at: ${directory}`);
      return true;
    } else {
      console.log(`${commandName} aborted by user. Existing directory "${directory}" was not modified.`);
      return false; // User aborted
    }
  } else {
    fs.mkdirSync(directory, { recursive: true });
    console.log(`Node directory created at: ${directory}`);
    return true;
  }
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
    if (!fs.existsSync(configPath)) {
      throw new Error(`Configuration file not found at ${configPath}. Please run 'lens-node setup' or 'lens-node import' first.`);
    }
    const configData = readFileSync(configPath, 'utf8');
    const config: SiteConfig = JSON.parse(configData);

    if (!validate(config)) {
      const errors = validate.errors?.map(err =>
        `${err.instancePath || 'config'} ${err.message}` // Added space for readability
      ).join('; ');
      throw new Error(`Invalid configuration: ${errors}`);
    }

    return config;
  } catch (error) {
    if (error instanceof Error) {
      // Avoid redundant "Failed to read config:" prefix if already present
      if (error.message.startsWith('Configuration file not found') || error.message.startsWith('Invalid configuration:')) {
        throw new Error(error.message);
      }
      throw new Error(`Failed to read config: ${error.message}`);
    }
    throw new Error('Failed to read config: Unknown error');
  }
}

export function readAndValidateCategoriesFile(filePath: string): ContentCategoryData<ContentCategoryMetadataField>[] {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(categoriesFileSchema);

  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Categories file not found at ${filePath}.`);
    }

    const fileData = readFileSync(filePath, 'utf8');
    const categories: ContentCategoryData<ContentCategoryMetadataField>[] = JSON.parse(fileData);

    if (!validate(categories)) {
      const errors = validate.errors?.map(err =>
        `${err.instancePath || 'categories'} ${err.message}`
      ).join('; ');
      throw new Error(`Invalid categories file format: ${errors}`);
    }

    return categories;
  } catch (error) {
    if (error instanceof Error) {
      // Re-throw with a more specific prefix
      throw new Error(`Failed to process categories file: ${error.message}`);
    }
    throw new Error('Failed to process categories file: Unknown error');
  }
}

export function logOperationSuccess(props: {
  startMessage: string,
  directory: string,
  configFilePath?: string,
  peerId: string,
  publicKey: string,
  siteAddress: string,
  listeningOn?: string[],
  finalMessage?: string
}) {
  console.log(props.startMessage);
  console.log('-'.repeat(50));
  console.log(`Node Directory: ${props.directory}`);
  if (props.configFilePath) {
    console.log(`Configuration saved to: ${props.configFilePath}`);
  }
  console.log(`Peer ID: ${props.peerId}`);
  console.log(`Node Public Key: ${props.publicKey}`);
  console.log(`Site Address: ${props.siteAddress}`);
  if (props.listeningOn) {
    console.log(`Listening on: ${JSON.stringify(props.listeningOn, null, 2)}`);
  }
  console.log('-'.repeat(50));
  if (props.finalMessage) {
    console.log(props.finalMessage);
  }
}