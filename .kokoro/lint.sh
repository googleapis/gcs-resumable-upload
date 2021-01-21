#!/bin/bash

# Copyright 2020 Google LLC
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.

set -eo pipefail

export NPM_CONFIG_PREFIX=${HOME}/.npm-global

cd $(dirname $0)/..

npm install

# Install and link samples
if [ -f samples/package.json ]; then
  cd samples/
  npm link ../
  npm install
  cd ..
fi

npm run lint
