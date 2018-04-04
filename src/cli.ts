#!/usr/bin/env node

'use strict';

const upload = require('./');
const args = process.argv.slice(2);

const opts = { bucket: args[0], file: args[1] };

process.stdin.pipe(upload(opts))
  .on('error', console.error)
  .on('response', (resp, metadata) => {
    if (!metadata || !metadata.mediaLink) return;
    console.log('uploaded!');
    console.log(metadata.mediaLink);
  });
