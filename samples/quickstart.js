/*!
 * Copyright 2020 Google LLC
 *
 * Use of this source code is governed by an MIT-style
 * license that can be found in the LICENSE file or at
 * https://opensource.org/licenses/MIT.
 */

/**
 * @fileoverview
 * This is an example of a command line application that takes a file path
 * and a bucket, and then uploads the file to GCS. It will show progress
 * information as the file as uploaded.  To use it, try running:
 *
 * @example
 * $ node samples/quickstart.js path/to/file.ext name-of-bucket
 */

// eslint-disable-next-line node/no-missing-require
const {upload} = require('gcs-resumable-upload');
const fs = require('fs');
const util = require('util');

async function main() {
  if (process.argv.length < 4) {
    throw new Error('Usage: node quickstart.js ${bucketName} ${filePath}');
  }
  const bucket = process.argv[3];
  const file = process.argv[2];

  const stat = util.promisify(fs.stat);
  const fileSize = (await stat(file)).size;
  console.log(`Uploading '${file}' to '${bucket}' ...`);

  return new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .pipe(upload({bucket, file}))
      .on('progress', progress => {
        console.log('Progress event:');
        console.log('\t bytes: ', progress.bytesWritten);
        const pct = Math.round((progress.bytesWritten / fileSize) * 100);
        console.log(`\t ${pct}%`);
      })
      .on('finish', () => {
        console.log('Upload complete!');
        resolve();
      })
      .on('error', err => {
        console.error('There was a problem uploading the file :(');
        reject(err);
      });
  });
}

main().catch(console.error);
