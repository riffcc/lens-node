import type { CommandModule } from 'yargs';

type RunCommandArgs = {}

const runCommand: CommandModule<{}, RunCommandArgs> = {
  command: 'run',
  describe: 'Starts a long-running process that listens for SIGINT.',
  builder: (yargs) =>
    yargs
    ,
  handler: async (argv) => {
    console.log('Process started. Waiting for SIGINT (Ctrl+C)...');

    let isShuttingDown = false;

    const shutdown = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      console.log(`\nReceived ${signal}. Shutting down gracefully...`);


      console.log('Cleanup finished.');

      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  },
};

export default runCommand;