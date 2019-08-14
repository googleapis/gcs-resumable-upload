/**
 * Copyright 2018 Google LLC
 *
 * Distributed under MIT license.
 * See file LICENSE for detail or copy at https://opensource.org/licenses/MIT
 */

import * as assert from 'assert';
import * as fs from 'fs';
import {Readable} from 'stream';
import {createURI, ErrorWithCode, upload} from '../src';

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
          assert.strictEqual(Number(metadata.size), size);
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
});
