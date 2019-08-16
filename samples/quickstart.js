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

/**
 * @fileoverview
 * This is an example of a command line application that takes a file path
 * and a bucket, and then uploads the file to GCS. It will show progress
 * information as the file as uploaded.  To use it, try running:
 *
 * @example
 * $ node samples/quickstart.js path/to/file.ext name-of-bucket
 */

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
      .pipe(upload({ bucket, file }))
      .on('progress', (progress) => {
        console.log('Progress event:')
        console.log('\t bytes: ', progress.bytesWritten);
        const pct = Math.round(progress.bytesWritten/fileSize*100);
        console.log(`\t ${pct}%`)
      })
      .on('finish', () => {
        console.log('Upload complete!');
        resolve();
      })
      .on('error', (err) => {
        console.error('There was a problem uploading the file :(');
        reject(err);
      })
    });
}

main().catch(console.error);
