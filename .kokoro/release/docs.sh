#!/bin/bash

# Copyright 2018 Google LLC
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.

set -eo pipefail

# build jsdocs (Python is installed on the Node 10 docker image).
if [[ -z "$CREDENTIALS" ]]; then
  # if CREDENTIALS are explicitly set, assume we're testing locally
  # and don't set NPM_CONFIG_PREFIX.
  export NPM_CONFIG_PREFIX=${HOME}/.npm-global
  export PATH="$PATH:${NPM_CONFIG_PREFIX}/bin"
  cd $(dirname $0)/../..
fi
npm install
npm run docs

# create docs.metadata, based on package.json and .repo-metadata.json.
npm i json@9.0.6 -g
python3 -m pip install --user gcp-docuploader
python3 -m docuploader create-metadata \
  --name=$(cat .repo-metadata.json | json name) \
  --version=$(cat package.json | json version) \
  --language=$(cat .repo-metadata.json | json language) \
  --distribution-name=$(cat .repo-metadata.json | json distribution_name) \
  --product-page=$(cat .repo-metadata.json | json product_documentation) \
  --github-repository=$(cat .repo-metadata.json | json repo) \
  --issue-tracker=$(cat .repo-metadata.json | json issue_tracker)
cp docs.metadata ./docs/docs.metadata

# deploy the docs.
if [[ -z "$CREDENTIALS" ]]; then
  CREDENTIALS=${KOKORO_KEYSTORE_DIR}/73713_docuploader_service_account
fi
if [[ -z "$BUCKET" ]]; then
  BUCKET=docs-staging
fi
python3 -m docuploader upload ./docs --credentials $CREDENTIALS --staging-bucket $BUCKET
