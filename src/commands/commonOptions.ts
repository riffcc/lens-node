import type { PositionalOptionsType } from "yargs";
import { getDefaultDir } from "../utils.js";

export const dirOption = {
  alias: 'd',
  type: 'string' as PositionalOptionsType,
  description: 'Directory for storing node data.',
  default: getDefaultDir(),
  normalize: true,
};