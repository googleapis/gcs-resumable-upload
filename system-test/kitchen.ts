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

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {Readable} from 'stream';
import {createURI, ErrorWithCode, upload, UploadConfig} from '../src';

const bucketName = process.env.BUCKET_NAME || 'gcs-resumable-upload-test';
const fileName = 'daw.jpg';

describe('end to end', () => {
  beforeEach(() => {
    upload({bucket: bucketName, file: fileName}).deleteConfig();
  });

  it('should work', done => {
    let uploadSucceeded = false;
    fs.createReadStream(fileName)
      .on('error', done)
      .pipe(
        upload({
          bucket: bucketName,
          file: fileName,
          metadata: {contentType: 'image/jpg'},
        })
      )
      .on('error', done)
      .on('response', resp => {
        uploadSucceeded = resp.status === 200;
      })
      .on('finish', () => {
        assert.strictEqual(uploadSucceeded, true);
        done();
      });
  });

  it('should resume an interrupted upload', done => {
    fs.stat(fileName, (err, fd) => {
      assert.ifError(err);

      const size = fd.size;

      // tslint:disable-next-line no-any
      type DoUploadCallback = (...args: any[]) => void;
      const doUpload = (
        opts: {interrupt?: boolean},
        callback: DoUploadCallback
      ) => {
        let sizeStreamed = 0;
        let destroyed = false;

        const ws = upload({
          bucket: bucketName,
          file: fileName,
          metadata: {contentType: 'image/jpg'},
        });

        fs.createReadStream(fileName)
          .on('error', callback)
          .on('data', function(this: Readable, chunk) {
            sizeStreamed += chunk.length;

            if (!destroyed && opts.interrupt && sizeStreamed >= size / 2) {
              // stop sending data half way through
              destroyed = true;
              this.destroy();
              process.nextTick(() => ws.destroy(new Error('Interrupted')));
            }
          })
          .pipe(ws)
          .on('error', callback)
          .on('metadata', callback.bind(null, null));
      };

      doUpload({interrupt: true}, (err: Error) => {
        assert.strictEqual(err.message, 'Interrupted');

        doUpload({interrupt: false}, (err: Error, metadata: {size: number}) => {
          assert.ifError(err);
          assert.strictEqual(metadata.size, size);
          assert.strictEqual(typeof metadata.size, 'number');
          done();
        });
      });
    });
  });

  it('should just make an upload URI', done => {
    createURI(
      {
        bucket: bucketName,
        file: fileName,
        metadata: {contentType: 'image/jpg'},
      },
      done
    );
  });

  it('should return a non-resumable failed upload', done => {
    const metadata = {
      metadata: {largeString: 'a'.repeat(2.1e6)},
    };

    fs.createReadStream(fileName)
      .on('error', done)
      .pipe(
        upload({
          bucket: bucketName,
          file: fileName,
          metadata,
        })
      )
      .on('error', (err: ErrorWithCode) => {
        assert.strictEqual(err.code, '400');
        done();
      });
  });

  it('should set custom config file', done => {
    const uploadOptions = {
      bucket: bucketName,
      file: fileName,
      metadata: {contentType: 'image/jpg'},
      configPath: path.join(
        os.tmpdir(),
        `test-gcs-resumable-${Date.now()}.json`
      ),
    };
    let uploadSucceeded = false;

    fs.createReadStream(fileName)
      .on('error', done)
      .pipe(upload(uploadOptions))
      .on('error', done)
      .on('response', resp => {
        uploadSucceeded = resp.status === 200;
      })
      .on('finish', () => {
        assert.strictEqual(uploadSucceeded, true);

        const configData = JSON.parse(
          fs.readFileSync(uploadOptions.configPath, 'utf8')
        );
        const keyName = `${uploadOptions.bucket}/${uploadOptions.file}`.replace(
          '.jpg',
          ''
        );
        assert.ok(Object.keys(configData).includes(keyName));
        done();
      });
  });
});
