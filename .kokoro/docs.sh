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

npm run docs-test
