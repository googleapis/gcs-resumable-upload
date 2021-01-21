#!/bin/bash

# Copyright 2018 Google LLC
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.

set -eo pipefail

export NPM_CONFIG_PREFIX=${HOME}/.npm-global

cd $(dirname $0)/..

npm install
# If tests are running against master, configure Build Cop
# to open issues on failures:
if [[ $KOKORO_BUILD_ARTIFACTS_SUBDIR = *"continuous"* ]] || [[ $KOKORO_BUILD_ARTIFACTS_SUBDIR = *"nightly"* ]]; then
  export MOCHA_REPORTER_OUTPUT=test_output_sponge_log.xml
  export MOCHA_REPORTER=xunit
  cleanup() {
    chmod +x $KOKORO_GFILE_DIR/linux_amd64/buildcop
    $KOKORO_GFILE_DIR/linux_amd64/buildcop
  }
  trap cleanup EXIT HUP
fi
npm test

# codecov combines coverage across integration and unit tests. Include
# the logic below for any environment you wish to collect coverage for:
COVERAGE_NODE=10
if npx check-node-version@3.3.0 --silent --node $COVERAGE_NODE; then
  NYC_BIN=./node_modules/nyc/bin/nyc.js
  if [ -f "$NYC_BIN" ]; then
    $NYC_BIN report || true
  fi
  bash $KOKORO_GFILE_DIR/codecov.sh
else
  echo "coverage is only reported for Node $COVERAGE_NODE"
fi
