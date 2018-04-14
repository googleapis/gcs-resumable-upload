#!/usr/bin/env node

import {RequestResponse} from '.';

const upload = require('./');
const args = process.argv.slice(2);
const opts = {
  bucket: args[0],
  file: args[1]
};

process.stdin.pipe(upload(opts))
    .on('error', console.error)
    .on('response', (resp: RequestResponse, metadata: {mediaLink: string}) => {
      if (!metadata || !metadata.mediaLink) return;
      console.log('uploaded!');
      console.log(metadata.mediaLink);
    });
