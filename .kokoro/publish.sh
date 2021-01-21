#!/bin/bash

# Copyright 2018 Google LLC
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.

set -eo pipefail

export NPM_CONFIG_PREFIX=${HOME}/.npm-global

# Start the releasetool reporter
python3 -m pip install gcp-releasetool
python3 -m releasetool publish-reporter-script > /tmp/publisher-script; source /tmp/publisher-script

cd $(dirname $0)/..

NPM_TOKEN=$(cat $KOKORO_GFILE_DIR/secret_manager/npm_publish_token)
echo "//wombat-dressing-room.appspot.com/:_authToken=${NPM_TOKEN}" > ~/.npmrc

npm install
npm publish --access=public --registry=https://wombat-dressing-room.appspot.com
