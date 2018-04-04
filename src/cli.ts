#!/usr/bin/env node
const upload = require('./');
const args = process.argv.slice(2);
const opts = { bucket: args[0], file: args[1] };
import * as r from 'request';

process.stdin.pipe(upload(opts))
  .on('error', console.error)
  .on('response', (resp: r.Response, metadata: any) => {
    if (!metadata || !metadata.mediaLink) return;
    console.log('uploaded!');
    console.log(metadata.mediaLink);
  });
