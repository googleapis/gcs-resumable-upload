#!/usr/bin/env node

/*!
 * Copyright 2018 Google LLC
 *
 * Use of this source code is governed by an MIT-style
 * license that can be found in the LICENSE file or at
 * https://opensource.org/licenses/MIT.
 */

import {upload} from '.';

const args = process.argv.slice(2);
const opts = {
  bucket: args[0],
  file: args[1],
};

process.stdin
  .pipe(upload(opts))
  .on('error', console.error)
  .on('response', (resp, metadata) => {
    if (!metadata || !metadata.mediaLink) return;
    console.log('uploaded!');
    console.log(metadata.mediaLink);
  });
