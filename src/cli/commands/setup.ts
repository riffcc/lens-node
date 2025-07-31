import type { CommandModule } from 'yargs';
import { handleDirectorySetup, logOperationSuccess, readAndValidateCategoriesFile, saveConfig } from '../utils.js';
import { Peerbit } from 'peerbit';
import { GlobalOptions } from '../types.js';
import { dirOption } from './commonOptions.js';
import { logError } from '../logger.js';
import { ContentCategoryData, ContentCategoryMetadataField, Site } from '@riffcc/lens-sdk';
import { confirm } from '@inquirer/prompts';

const setupCommand: CommandModule<{}, GlobalOptions & { categoriesFile?: string; }> = {
  command: 'setup',
  describe: 'Setup the lens node and generate a new ID.',
  builder: (yargs) =>
    yargs
      .option('dir', dirOption)
      .option('categoriesFile', {
        type: 'string',
        alias: 'c',
        describe: 'Path to a JSON file with custom content categories for initialization.'
      })
  ,
  handler: async (argv) => {
    const { dir, categoriesFile } = argv;

    try {
      const proceed = await handleDirectorySetup(dir, 'setup');
      if (!proceed) {
        process.exit(0);
      }

      let customCategories: ContentCategoryData<ContentCategoryMetadataField>[] | undefined = undefined;

      if (categoriesFile) {
        try {
          console.log(`\nReading categories file from: ${categoriesFile}`);
          const categoriesFromFile = readAndValidateCategoriesFile(categoriesFile);

          const useFile = await confirm({
            message: `Found ${categoriesFromFile.length} categories in the file. Do you want to use them to initialize the site?`,
            default: true,
          });

          if (useFile) {
            customCategories = categoriesFromFile;
            console.log('Custom categories will be used for initialization.');
          } else {
            console.log('Using default categories for initialization.');
          }
        } catch (e) {
          logError('Error processing categories file. Will proceed with default categories.', e);
        }
      }

      const client = await Peerbit.create({ directory: dir });
      const siteProgram = new Site({ rootAdmin: client.identity.publicKey });
      const site = await client.open(siteProgram);
      await site.initContentCategories(customCategories);
      const configFilePath = saveConfig({ address: site.address }, dir);

      logOperationSuccess({
        startMessage: '\nLens Node setup complete!',
        directory: dir,
        configFilePath,
        peerId: client.peerId.toString(),
        publicKey: client.identity.publicKey.toString(),
        siteAddress: site.address,
        finalMessage: "You can now run your node using: lens-node run"
      });

      await siteProgram.close();
      await client.stop();
      process.exit(0);
    } catch (e) {
      logError('Error on setup', e);
      process.exit(1);
    }
  }
};

export default setupCommand;
