#!/usr/bin/env node
'use strict';
// Thin launcher for the unscoped `agentmonitors` package: it exists so users can
// `npm i -g agentmonitors` and get the `agentmonitors` binary. All behavior lives
// in `@agentmonitors/cli`; resolve its declared bin entry and run it (its entry
// executes the program on load).
const path = require('node:path');
const cliPkgJsonPath = require.resolve('@agentmonitors/cli/package.json');
const cliPkgJson = require(cliPkgJsonPath);
const binField = cliPkgJson.bin;
const binRel = typeof binField === 'string' ? binField : binField.agentmonitors;
require(path.join(path.dirname(cliPkgJsonPath), binRel));
