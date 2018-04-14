import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {RequestResponse} from '../../src';
const upload = require('../../src');

const dawPath = path.join(__dirname, 'test/fixtures/daw.jpg');

describe('end to end', () => {
  it('should work', (done) => {
    let uploadSucceeded = false;
    fs.createReadStream(dawPath)
        .on('error', done)
        .pipe(upload({
          bucket: 'stephen-has-a-new-bucket',
          file: 'daw.jpg',
          metadata: {contentType: 'image/jpg'}
        }))
        .on('error', done)
        .on('response',
            (resp: RequestResponse) => {
              uploadSucceeded = resp.status === 200;
            })
        .on('finish', () => {
          assert.strictEqual(uploadSucceeded, true);
          done();
        });
  });

  it('should resume an interrupted upload', (done) => {
    fs.stat(dawPath, (err, fd) => {
      assert.ifError(err);

      const size = fd.size;

      // tslint:disable-next-line no-any
      type DoUploadCallback = (...args: any[]) => void;
      const doUpload =
          (opts: {interrupt?: boolean}, callback: DoUploadCallback) => {
            let sizeStreamed = 0;
            let destroyed = false;

            const ws = upload({
              bucket: 'stephen-has-a-new-bucket',
              file: 'daw.jpg',
              metadata: {contentType: 'image/jpg'}
            });

            fs.createReadStream(dawPath)
                .on('error', callback)
                .on('data',
                    function(chunk) {
                      sizeStreamed += chunk.length;

                      if (!destroyed && opts.interrupt &&
                          sizeStreamed >= size / 2) {
                        // stop sending data half way through
                        destroyed = true;
                        this.destroy();
                        ws.destroy(new Error('Interrupted'));
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
          assert.equal(metadata.size, size);
          done();
        });
      });
    });
  });

  it('should just make an upload URI', (done) => {
    upload.createURI(
        {
          bucket: 'stephen-has-a-new-bucket',
          file: 'daw.jpg',
          metadata: {contentType: 'image/jpg'}
        },
        done);
  });
});