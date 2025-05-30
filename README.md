# @riffcc/lens-node

![npm version](https://img.shields.io/npm/v/@riffcc/lens-node)[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/riffcc/lens-node)
<!-- ![license](https://img.shields.io/npm/l/@riffcc/lens-node) -->

`@riffcc/lens-node` is a command-line interface (CLI) for setting up and running your Lens node. It utilizes [Peerbit](https://peerbit.org/) for peer-to-peer networking and the `@riffcc/lens-sdk` to interact with the Lens ecosystem.

## Table of Contents

- [@riffcc/lens-node](#riffcclens-node)
  - [Table of Contents](#table-of-contents)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Getting Started](#getting-started)
  - [Usage](#usage)
    - [Global Options](#global-options)
    - [Commands](#commands)
      - [`setup`](#setup)
      - [`import`](#import)
      - [`export`](#export)
      - [`run`](#run)
  - [Configuration](#configuration)
  - [Development](#development)

## Prerequisites

- A recent version of Node.js (v18.x or later recommended).
- `pnpm` is recommended for development (as per `package.json`), but `npm` or `yarn` can be used for global installation.

## Installation

To install the `lens-node` CLI globally, run:

```bash
pnpm add -g @riffcc/lens-node
```

Or, using `npm`:

```bash
npm install -g @riffcc/lens-node
```

Or, using `yarn`:

```bash
yarn global add @riffcc/lens-node
```

After installation, the `lens-node` command will be available in your terminal.

## Getting Started

1. **Setup your Lens Node:**
    The first step is to initialize your node. This will create a data directory, generate necessary cryptographic identities, and create a configuration file.

    ```bash
    lens-node setup
    ```

    This command will:
    - Create a directory at `~/.lens-node` (or a custom path if specified with `--dir`).
    - If the directory already exists, it will prompt you to confirm reconfiguration.
    - Initialize a Peerbit client and a Lens Site.
    - Save the configuration, including the Lens Site address, to `config.json` within the data directory.
    - Print important details like your Peer ID, Public Key, and Site Address.

2. **Import an existing site:**
    Alternatively, you can import an existing site ID to become a lens for that site:

    ```bash
    lens-node import
    ```

    This command will:
    - Create a directory at `~/.lens-node` (or a custom path if specified with `--dir`).
    - If the directory already exists, it will prompt you to confirm reconfiguration.
    - Prompt you to enter the site address to import.
    - Initialize a Peerbit client.
    - Save the configuration with the imported site address to `config.json`.
    - Print important details like your Peer ID, Public Key, and the imported Site Address.

3. **Run your Lens Node:**
    Once setup or import is complete, you can start your node:

    ```bash
    lens-node run
    ```

    This will start the node daemon, connect to the Peerbit network, and open your Lens Site. An interactive menu will be available for further actions.

## Usage

The basic syntax for the CLI is:

```bash
lens-node <command> [options]
```

You can get help at any time:

```bash
lens-node --help
lens-node <command> --help
```

### Global Options

These options are available for most commands:

- `--dir <path>`, `-d <path>`: Specifies the directory for storing node data.
  - Default: `~/.lens-node` (e.g., `/home/user/.lens-node` on Linux or `/Users/user/.lens-node` on macOS).
- `--help`, `-h`: Show help.
- `--version`, `-v`: Show version number.

### Commands

#### `setup`

Initializes and configures a new Lens node.

```bash
lens-node setup [options]
```

**Description:**
Sets up the Lens node by creating a data directory, generating a Peerbit identity, creating a new Lens Site, and saving its address to a configuration file.

**Options:**

- `--dir <path>`, `-d <path>`
  - Directory to store node data.
  - Default: `~/.lens-node`

**Example:**

```bash
# Setup with default directory
lens-node setup

# Setup with a custom directory
lens-node setup --dir /path/to/my/lens-node-data
```

#### `import`

Imports an existing site ID to become a lens for that site.

```bash
lens-node import [options]
```

**Description:**
Imports an existing site ID by creating a data directory, generating a Peerbit identity, and saving the imported site address to a configuration file.

**Options:**

- `--dir <path>`, `-d <path>`
  - Directory to store node data.
  - Default: `~/.lens-node`

**Example:**

```bash
# Import with default directory
lens-node import

# Import with a custom directory
lens-node import --dir /path/to/my/lens-node-data
```

#### `export`

Exports the current node configuration to a specified format (JSON or Vite .env).

```bash
lens-node export [options]
```

**Description:**
Reads the `config.json` from the node data directory and outputs it. This is useful for backing up your configuration or integrating with other tools.

**Options:**

- `--dir <path>`, `-d <path>`
  - Specifies the directory where node data (including `config.json`) is stored.
  - Default: `~/.lens-node`
- `--format <json|vite>`, `-f <json|vite>` (Required)
  - The format for the exported configuration.
    - `json`: Outputs the full `config.json` content.
    - `vite`: Outputs a `.env` style file with `VITE_ADDRESS=<site_address>`.
- `--output <filepath>`, `-o <filepath>`
  - Optional. The file path to save the exported configuration.
  - If not provided, the configuration will be printed to standard output (your terminal).
  - If a directory path is provided, a default filename (e.g., `config_export.json` or `config_export.env`) will be used within that directory.

**Examples:**

```bash
# Export configuration as JSON to the terminal
lens-node export --format json

# Export configuration as a Vite .env file and save it to .env in the current directory
lens-node export --format vite --output .env

# Export configuration as JSON from a custom data directory and save to a backup file
lens-node export --format json --dir /path/to/my-data --output /backups/lens_config_backup.json
```

#### `run`

Starts the Lens node daemon.

```bash
lens-node run [options]
```

**Description:**
Starts the Lens node, connects to the Peerbit network, and opens the configured Lens Site. It provides an interactive menu for actions like authorizing accounts.

**Options:**

- `--dir <path>`, `-d <path>`
  - Directory where node data (including `config.json`) is stored.
  - Default: `~/.lens-node`
- `--relay`
  - Type: `boolean`
  - Default: `false`
  - Enable relay mode for the node.
- `--domain <domain1>`
  - Type: `string`
  - Domain to announce for libp2p configuration (e.g., for external reachability).
  - Example: `--domain my-node.example.com`
- `--listenPort <port>`
  - Type: `number`
  - Default: `8001`
  - Port to listen on for libp2p configuration.
- `--onlyReplicate`
  - Type: `boolean`
  - Default: `false`
  - Run the node in replicator mode. This uses replication settings to run this node as dedicated replicator and disables the interactive menu.

**Example:**

```bash
# Run the node using default configuration
lens-node run

# Run the node in relay mode
lens-node run --relay

# Run the node and announce specific domains
lens-node run --domains /dns4/node1.example.com/tcp/4002/p2p/QmRelayPeerId /ip4/123.45.67.89/tcp/9000
```

**Interactive Menu Actions:**

- **Authorise an account:** Prompts for a string public key and account type (Member or Admin) to authorize on the Lens Site.
- **Shutdown Node:** Gracefully shuts down the node.

The node can also be stopped by pressing `Ctrl+C`.

## Configuration

The `lens-node` stores its configuration in a `config.json` file located within the node's data directory (default: `~/.lens-node/config.json`).

The primary piece of configuration stored is the Lens Site address:

```json
{
  "address": "zd...siteAddress..."
}
```

This file is automatically generated by the `lens-node setup` or `lens-node import` command and read by the `lens-node run` command. The configuration is validated against a schema on load.

## Development

If you want to contribute to or modify `lens-node`:

**Clone the repository:**

```bash
git clone https://github.com/riffcc/lens-node.git

cd lens-node
```

**Install dependencies (using pnpm):**
The project is set up to use `pnpm`.

```bash
pnpm install
```

**Build the project:**
This compiles the TypeScript code to JavaScript in the `dist` directory.

```bash
pnpm run build
```
