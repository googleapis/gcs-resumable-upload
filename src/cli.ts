#!/usr/bin/env node

/*!
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
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
