/**
 * Copyright 2018 Google LLC
 *
 * Distributed under MIT license.
 * See file LICENSE for detail or copy at https://opensource.org/licenses/MIT
 */

import * as assert from 'assert';
import * as crypto from 'crypto';
import {EventEmitter} from 'events';
import * as isStream from 'is-stream';
import * as mockery from 'mockery';
import * as nock from 'nock';
import * as path from 'path';
import * as stream from 'stream';
import * as through from 'through2';
import * as url from 'url';

import {CreateUriCallback} from '../src';
import {RequestBody, RequestCallback, RequestOptions, RequestResponse} from '../src/types';

const dawPath = path.join(__dirname, '../../daw.jpg');

nock.disableNetConnect();

let configData = {} as {[index: string]: {}};
class ConfigStore {
  delete(key: string) {
    delete configData[key];
  }
  get(key: string) {
    return configData[key];
  }
  set(key: string, value: {}) {
    configData[key] = value;
  }
}

const queryPath = '/?userProject=user-project-id';

function mockAuthorizeRequest(code = 200, data: {}|string = {
  access_token: 'abc123'
}) {
  return nock('https://www.googleapis.com')
      .post('/oauth2/v4/token')
      .reply(code, data);
}

describe('gcs-resumable-upload', () => {
  // tslint:disable-next-line no-any
  let upload: any;
  // tslint:disable-next-line no-any
  let up: any;

  const BUCKET = 'bucket-name';
  const FILE = 'file-name';
  const GENERATION = Date.now();
  const METADATA = {contentLength: 1024, contentType: 'application/json'};
  const ORIGIN = '*';
  const PREDEFINED_ACL = 'authenticatedRead';
  const USER_PROJECT = 'user-project-id';
  const REQ_OPTS = {url: 'http://fake.local'};
  const keyFile = path.join(__dirname, '../../test/fixtures/keys.json');

  before(() => {
    mockery.registerMock('configstore', ConfigStore);
    mockery.enable({useCleanCache: true, warnOnUnregistered: false});
    upload = require('../src').upload;
  });

  beforeEach(() => {
    configData = {};
    up = upload({
      bucket: BUCKET,
      file: FILE,
      generation: GENERATION,
      metadata: METADATA,
      origin: ORIGIN,
      predefinedAcl: PREDEFINED_ACL,
      userProject: USER_PROJECT,
      authConfig: {keyFile}
    });
  });

  afterEach(() => {
    nock.cleanAll();
  });

  after(() => {
    mockery.deregisterAll();
    mockery.disable();
  });

  describe('ctor', () => {
    it('should throw if a bucket or file is not given', () => {
      assert.throws(() => {
        upload();
      }, /A bucket and file name are required/);
    });

    it('should localize the bucket and file', () => {
      assert.strictEqual(up.bucket, BUCKET);
      assert.strictEqual(up.file, FILE);
    });

    it('should localize the generation', () => {
      assert.strictEqual(up.generation, GENERATION);
    });

    it('should localize the KMS key name', () => {
      const kmsKeyName = 'kms-key-name';
      const up = upload({bucket: 'BUCKET', file: FILE, kmsKeyName});
      assert.strictEqual(up.kmsKeyName, kmsKeyName);
    });

    it('should localize metadata or default to empty object', () => {
      assert.strictEqual(up.metadata, METADATA);

      const upWithoutMetadata = upload({bucket: BUCKET, file: FILE});
      assert.deepEqual(upWithoutMetadata.metadata, {});
    });

    it('should set the offset if it is provided', () => {
      const offset = 10;
      const up = upload({bucket: BUCKET, file: FILE, offset});

      assert.strictEqual(up.offset, offset);
    });

    it('should localize the origin', () => {
      assert.strictEqual(up.origin, ORIGIN);
    });

    it('should localize userProject', () => {
      assert.strictEqual(up.userProject, USER_PROJECT);
    });

    it('should localize an encryption object from a key', () => {
      const key = crypto.randomBytes(32);
      const up = upload({bucket: BUCKET, file: FILE, key});
      const expectedKey = key.toString('base64');
      const expectedHash =
          crypto.createHash('sha256').update(key).digest('base64');
      assert.deepEqual(up.encryption, {key: expectedKey, hash: expectedHash});
    });

    it('should localize the predefinedAcl', () => {
      assert.strictEqual(up.predefinedAcl, PREDEFINED_ACL);
    });

    it('should set the predefinedAcl with public: true', () => {
      const up = upload({bucket: BUCKET, file: FILE, public: true});
      assert.strictEqual(up.predefinedAcl, 'publicRead');
    });

    it('should set the predefinedAcl with private: true', () => {
      const up = upload({bucket: BUCKET, file: FILE, private: true});
      assert.strictEqual(up.predefinedAcl, 'private');
    });

    it('should set numBytesWritten to 0', () => {
      assert.strictEqual(up.numBytesWritten, 0);
    });

    it('should set numRetries to 0', () => {
      assert.strictEqual(up.numRetries, 0);
    });

    it('should set the contentLength if provided', () => {
      const up = upload({
        bucket: BUCKET,
        file: FILE,
        metadata: {contentLength: METADATA.contentLength}
      });
      assert.strictEqual(up.contentLength, METADATA.contentLength);
    });

    it('should default the contentLength to *', () => {
      const up = upload({bucket: BUCKET, file: FILE});
      assert.strictEqual(up.contentLength, '*');
    });

    it('should localize the uri or get one from config', () => {
      const uri = 'http://www.blah.com/';
      const upWithUri = upload({bucket: BUCKET, file: FILE, uri});
      assert.strictEqual(upWithUri.uriProvidedManually, true);
      assert.strictEqual(upWithUri.uri, uri);

      configData[[BUCKET, FILE].join('/')] = {uri: 'fake-uri'};
      const up = upload({bucket: BUCKET, file: FILE});
      assert.strictEqual(up.uriProvidedManually, false);
      assert.strictEqual(up.uri, 'fake-uri');
    });

    describe('on write', () => {
      const URI = 'uri';

      it('should continue uploading', (done) => {
        up.uri = URI;
        up.continueUploading = done;
        up.emit('writing');
      });

      it('should create an upload', (done) => {
        up.startUploading = done;
        up.createURI = (callback: CreateUriCallback) => {
          callback(null);
        };
        up.emit('writing');
      });

      it('should destroy the stream from an error', (done) => {
        const error = new Error(':(');
        up.destroy = (err: Error) => {
          assert(err.message.indexOf(error.message) > -1);
          done();
        };
        up.createURI = (callback: CreateUriCallback) => {
          callback(error);
        };
        up.emit('writing');
      });
    });
  });

  describe('#createURI', () => {
    it('should make the correct request', (done) => {
      up.makeRequest = (reqOpts: RequestOptions) => {
        assert.strictEqual(reqOpts.method, 'POST');
        assert.strictEqual(
            reqOpts.url,
            `https://www.googleapis.com/upload/storage/v1/b/${BUCKET}/o`);
        assert.deepEqual(reqOpts.params, {
          predefinedAcl: up.predefinedAcl,
          name: FILE,
          uploadType: 'resumable',
          ifGenerationMatch: GENERATION
        });
        assert.strictEqual(reqOpts.data, up.metadata);
        done();
      };

      up.createURI();
    });

    it('should pass through the KMS key name', (done) => {
      const kmsKeyName = 'kms-key-name';
      const up = upload({bucket: BUCKET, file: FILE, kmsKeyName});

      up.makeRequest = (reqOpts: RequestOptions) => {
        assert.strictEqual(reqOpts.params.kmsKeyName, kmsKeyName);
        done();
      };

      up.createURI();
    });

    it('should respect 0 as a generation', (done) => {
      up.makeRequest = (reqOpts: RequestOptions) => {
        assert.strictEqual(reqOpts.params.ifGenerationMatch, 0);
        done();
      };
      up.generation = 0;
      up.createURI();
    });

    describe('error', () => {
      const error = new Error(':(');

      beforeEach(() => {
        up.makeRequest =
            (reqOpts: RequestOptions, callback: RequestCallback) => {
              callback(error, null!, null);
            };
      });

      it('should exec callback with error', (done) => {
        up.createURI((err: Error) => {
          assert.strictEqual(err, error);
          done();
        });
      });
    });

    describe('success', () => {
      const URI = 'uri';
      const RESP = {headers: {location: URI}} as RequestResponse;

      beforeEach(() => {
        up.makeRequest =
            (reqOpts: RequestOptions, callback: RequestCallback) => {
              callback(null, RESP, null);
            };
      });

      it('should localize the uri', (done) => {
        up.createURI((err: Error) => {
          assert.ifError(err);
          assert.strictEqual(up.uri, URI);
          assert.strictEqual(up.offset, 0);
          done();
        });
      });

      it('should save the uri to config', (done) => {
        up.set = (props: {}) => {
          assert.deepEqual(props, {uri: URI});
          done();
        };

        up.createURI(assert.ifError);
      });

      it('should default the offset to 0', (done) => {
        up.createURI((err: Error) => {
          assert.ifError(err);
          assert.strictEqual(up.offset, 0);
          done();
        });
      });

      it('should exec callback with URI', (done) => {
        up.createURI((err: Error, uri: string) => {
          assert.ifError(err);
          assert.strictEqual(uri, URI);
          done();
        });
      });
    });
  });

  describe('#continueUploading', () => {
    it('should start uploading if an offset was set', (done) => {
      up.offset = 0;

      up.startUploading = () => {
        done();
      };

      up.continueUploading();
    });

    it('should get and set offset if no offset was set', (done) => {
      up.getAndSetOffset = () => {
        done();
      };

      up.continueUploading();
    });

    it('should start uploading when done', (done) => {
      up.startUploading = function() {
        assert.strictEqual(this, up);
        done();
      };
      up.getAndSetOffset = (callback: Function) => {
        callback();
      };
      up.continueUploading();
    });
  });

  describe('#startUploading', () => {
    beforeEach(() => {
      up.getRequestStream = () => {};
    });

    it('should make the correct request', (done) => {
      const URI = 'uri';
      const OFFSET = 8;

      up.uri = URI;
      up.offset = OFFSET;

      up.getRequestStream = (reqOpts: RequestOptions) => {
        assert.strictEqual(reqOpts.method, 'PUT');
        assert.strictEqual(reqOpts.url, up.uri);
        assert.deepEqual(
            reqOpts.headers,
            {'Content-Range': 'bytes ' + OFFSET + '-*/' + up.contentLength});
        done();
      };

      up.startUploading();
    });

    it('should create a buffer stream', () => {
      assert.strictEqual(up.bufferStream, undefined);
      up.startUploading();
      assert.strictEqual(isStream(up.bufferStream), true);
    });

    it('should create an offset stream', () => {
      assert.strictEqual(up.offsetStream, undefined);
      up.startUploading();
      assert.strictEqual(isStream(up.offsetStream), true);
    });

    it('should set the pipeline', (done) => {
      const requestStream = through();

      up.setPipeline =
          (buffer: Buffer, offset: number, request: stream.Readable,
           delay: number) => {
            assert.strictEqual(buffer, up.bufferStream);
            assert.strictEqual(offset, up.offsetStream);
            assert.strictEqual(request, requestStream);
            assert.strictEqual(isStream(delay), true);

            done();
          };

      up.getRequestStream = (reqOpts: RequestOptions, callback: Function) => {
        callback(requestStream);
      };

      up.startUploading();
    });

    it('should cork the stream on prefinish', (done) => {
      up.cork = done;
      up.setPipeline =
          (buffer: Buffer, offset: number, request: stream.Readable,
           delay: EventEmitter) => {
            setImmediate(() => {
              delay.emit('prefinish');
            });
          };

      up.getRequestStream = (reqOpts: RequestOptions, callback: Function) => {
        callback(through());
      };

      up.startUploading();
    });

    it('should emit the metadata', (done) => {
      const BODY = {hi: 1};
      const RESP = {body: BODY};

      const requestStream = through();

      up.getRequestStream = (reqOpts: RequestOptions, callback: Function) => {
        callback(requestStream);

        up.on('metadata', (body: {}) => {
          assert.strictEqual(body, BODY);
          done();
        });

        requestStream.emit('complete', RESP);
      };

      up.startUploading();
    });

    it('should destroy the stream if an error occurred', (done) => {
      const RESP = {body: '', statusCode: 404};
      const requestStream = through();

      up.getRequestStream = (reqOpts: RequestOptions, callback: Function) => {
        callback(requestStream);

        // metadata shouldn't be emitted... will blow up test if called
        up.on('metadata', done);
        up.destroy = (err: Error) => {
          assert.strictEqual(err.message, 'Upload failed');
          done();
        };
        requestStream.emit('complete', RESP);
      };
      up.startUploading();
    });

    it('should delete the config', (done) => {
      const RESP = {body: ''};
      const requestStream = through();
      up.getRequestStream = (reqOpts: RequestOptions, callback: Function) => {
        callback(requestStream);
        up.deleteConfig = done;
        requestStream.emit('complete', RESP);
      };
      up.startUploading();
    });

    it('should uncork the stream', (done) => {
      const RESP = {body: ''};
      const requestStream = through();
      up.getRequestStream = (reqOpts: RequestOptions, callback: Function) => {
        callback(requestStream);
        up.uncork = done;
        requestStream.emit('complete', RESP);
      };
      up.startUploading();
    });
  });

  describe('#onChunk', () => {
    const CHUNK = Buffer.from('abcdefghijklmnopqrstuvwxyz');
    const ENC = 'utf-8';
    const NEXT = () => {};

    describe('first write', () => {
      beforeEach(() => {
        up.numBytesWritten = 0;
      });

      it('should get the first chunk', (done) => {
        up.get = (prop: string) => {
          assert.strictEqual(prop, 'firstChunk');
          done();
        };

        up.onChunk(CHUNK, ENC, NEXT);
      });

      describe('new upload', () => {
        beforeEach(() => {
          up.get = () => {};
        });

        it('should save the uri and first chunk if its not cached', () => {
          const URI = 'uri';
          up.uri = URI;
          up.set = (props: {uri?: string, firstChunk: Buffer}) => {
            const firstChunk = CHUNK.slice(0, 16);
            assert.deepEqual(props.uri, URI);
            assert.strictEqual(Buffer.compare(props.firstChunk, firstChunk), 0);
          };
          up.onChunk(CHUNK, ENC, NEXT);
        });
      });

      describe('continued upload', () => {
        beforeEach(() => {
          up.bufferStream = through();
          up.offsetStream = through();
          up.get = () => CHUNK;
          up.restart = () => {};
        });

        it('should push data back to the buffer stream if different',
           (done) => {
             up.bufferStream.unshift = (chunk: string) => {
               assert.strictEqual(chunk, CHUNK);
               done();
             };

             up.onChunk(CHUNK, ENC, NEXT);
           });

        it('should unpipe the offset stream', (done) => {
          up.bufferStream.unpipe = (stream: stream.Readable) => {
            assert.strictEqual(stream, up.offsetStream);
            done();
          };

          up.onChunk(CHUNK, ENC, NEXT);
        });

        it('should restart the stream', (done) => {
          up.restart = done;

          up.onChunk(CHUNK, ENC, NEXT);
        });
      });
    });

    describe('successive writes', () => {
      it('should increase the length of the bytes written by the bytelength of the chunk',
         () => {
           assert.strictEqual(up.numBytesWritten, 0);
           up.onChunk(CHUNK, ENC, NEXT);
           assert.strictEqual(
               up.numBytesWritten, Buffer.byteLength(CHUNK, ENC));
         });

      it('should slice the chunk by the offset - numBytesWritten', (done) => {
        const OFFSET = 8;
        up.offset = OFFSET;
        up.onChunk(CHUNK, ENC, (err: Error, chunk: Buffer) => {
          assert.ifError(err);

          const expectedChunk = CHUNK.slice(OFFSET);
          assert.strictEqual(Buffer.compare(chunk, expectedChunk), 0);
          done();
        });
      });
    });

    describe('next()', () => {
      it('should push data to the stream if the bytes written is > offset',
         (done) => {
           up.numBytesWritten = 10;
           up.offset = 0;

           up.onChunk(CHUNK, ENC, (err: Error, chunk: string) => {
             assert.ifError(err);
             assert.strictEqual(Buffer.isBuffer(chunk), true);
             done();
           });
         });

      it('should not push data to the stream if the bytes written is < offset',
         (done) => {
           up.numBytesWritten = 0;
           up.offset = 1000;

           up.onChunk(CHUNK, ENC, (err: Error, chunk: string) => {
             assert.ifError(err);
             assert.strictEqual(chunk, undefined);
             done();
           });
         });
    });
  });

  describe('#getAndSetOffset', () => {
    const RANGE = 123456;

    // tslint:disable-next-line no-any
    const RESP = {status: 308, headers: {range: `range-${RANGE}`}} as
        RequestResponse;

    it('should make the correct request', (done) => {
      const URI = 'uri';
      up.uri = URI;
      up.makeRequest = (reqOpts: RequestOptions) => {
        assert.strictEqual(reqOpts.method, 'PUT');
        assert.strictEqual(reqOpts.url, URI);
        assert.deepEqual(
            reqOpts.headers,
            {'Content-Length': 0, 'Content-Range': 'bytes */*'});

        done();
      };

      up.getAndSetOffset();
    });

    describe('restart on 404', () => {
      const ERROR = new Error(':(');
      const RESP = {status: 404} as RequestResponse;

      beforeEach(() => {
        up.makeRequest =
            (reqOpts: RequestOptions, callback: RequestCallback) => {
              callback(ERROR, RESP, null);
            };
      });

      it('should restart the upload', (done) => {
        up.restart = done;
        up.getAndSetOffset();
      });

      it('should not restart if URI provided manually', (done) => {
        up.uriProvidedManually = true;
        up.restart = done;  // will cause test to fail
        up.on('error', (err: Error) => {
          assert.strictEqual(err, ERROR);
          done();
        });
        up.getAndSetOffset();
      });
    });

    describe('restart on 410', () => {
      const ERROR = new Error(':(');
      const RESP = {status: 410} as RequestResponse;

      beforeEach(() => {
        up.makeRequest =
            (reqOpts: RequestOptions, callback: RequestCallback) => {
              callback(ERROR, RESP, null);
            };
      });

      it('should restart the upload', (done) => {
        up.restart = done;
        up.getAndSetOffset();
      });
    });

    it('should set the offset from the range', (done) => {
      up.makeRequest = (reqOpts: RequestOptions, callback: RequestCallback) => {
        callback(null, RESP, null);
      };

      up.getAndSetOffset(() => {
        assert.strictEqual(up.offset, RANGE + 1);
        done();
      });
    });

    it('should set the offset to 0 if no range is back from the API',
       (done) => {
         up.makeRequest =
             (reqOpts: RequestOptions, callback: RequestCallback) => {
               callback(null, {} as RequestResponse, null);
             };

         up.getAndSetOffset(() => {
           assert.strictEqual(up.offset, 0);
           done();
         });
       });
  });

  describe('#makeRequest', () => {
    it('should set encryption headers', (done) => {
      const key = crypto.randomBytes(32);
      const up =
          upload({bucket: 'BUCKET', file: FILE, key, authConfig: {keyFile}});
      const scopes =
          [mockAuthorizeRequest(), nock(REQ_OPTS.url).get('/').reply(200, {})];
      up.makeRequest(REQ_OPTS, (err: Error|null, res: RequestResponse) => {
        assert.ifError(err);
        scopes.forEach(x => x.done());
        const headers = res.config.headers;
        assert.equal(headers['x-goog-encryption-algorithm'], 'AES256');
        assert.equal(headers['x-goog-encryption-key'], up.encryption.key);
        assert.equal(
            headers['x-goog-encryption-key-sha256'], up.encryption.hash);
        done();
      });
    });

    it('should set userProject', (done) => {
      const scopes = [
        mockAuthorizeRequest(), nock(REQ_OPTS.url).get(queryPath).reply(200, {})
      ];
      up.makeRequest(REQ_OPTS, (err: Error|null, res: RequestResponse) => {
        assert.ifError(err);
        assert.deepEqual(res.config.params, {userProject: USER_PROJECT});
        scopes.forEach(x => x.done());
        done();
      });
    });

    it('should execute the callback with error & response if one occurred',
       (done) => {
         const response = {} as RequestResponse;
         const scope = mockAuthorizeRequest(500, ':(');
         up.makeRequest({}, (err: Error, resp: RequestResponse) => {
           assert.equal(err.message, 'Request failed with status code 500');
           done();
         });
       });

    it('should make the correct request', (done) => {
      const headers = {};
      const scopes = [
        mockAuthorizeRequest(),
        nock(REQ_OPTS.url).get(queryPath).reply(200, undefined, headers)
      ];
      up.makeRequest(REQ_OPTS, (err: Error|null, res: RequestResponse) => {
        assert.ifError(err);
        scopes.forEach(x => x.done());
        assert.strictEqual(res.config.url, REQ_OPTS.url);
        assert.deepStrictEqual(res.headers, {});
        done();
      });
    });

    it('should execute the callback with error & response', (done) => {
      const response = {data: 'wooo'} as RequestResponse;
      mockAuthorizeRequest();
      const scope = nock(REQ_OPTS.url).get(queryPath).reply(500, response.data);
      up.makeRequest(REQ_OPTS, (err: Error, resp: RequestResponse) => {
        assert.strictEqual(resp.data, response.data);
        scope.done();
        done();
      });
    });

    it('should execute the callback with a body error & response', (done) => {
      const response = {error: ':('};
      mockAuthorizeRequest();
      const scope = nock(REQ_OPTS.url).get(queryPath).reply(500, response);
      up.makeRequest(REQ_OPTS, (err: Error, res: RequestResponse) => {
        assert.equal(res.status, 500);
        assert.deepStrictEqual(response, res.data);
        done();
      });
    });

    it('should execute the callback with a body error & response for non-2xx status codes',
       (done) => {
         const response = {status: 500, body: {error: '!$#@'}};
         mockAuthorizeRequest();
         const scope =
             nock(REQ_OPTS.url).get(queryPath).reply(500, response.body);
         up.makeRequest(
             REQ_OPTS,
             (err: Error, resp: RequestResponse, body: RequestBody) => {
               assert.strictEqual(err, response.body.error);
               assert.deepStrictEqual(resp.status, 500);
               assert.deepStrictEqual(body, response.body);
               done();
             });
       });

    it('should execute the callback', (done) => {
      const data = {red: 'tape'};
      mockAuthorizeRequest();
      up.onResponse = () => {
        return true;
      };
      const scope = nock(REQ_OPTS.url).get(queryPath).reply(200, data);
      up.makeRequest(
          REQ_OPTS, (err: Error, res: RequestResponse, body: RequestBody) => {
            assert.ifError(err);
            scope.done();
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(body, data);
            done();
          });
    });
  });

  describe('#getRequestStream', () => {
    it('should authorize the request', (done) => {
      const scopes = [
        mockAuthorizeRequest(), nock(REQ_OPTS.url).get(queryPath).reply(200)
      ];
      up.getRequestStream(REQ_OPTS, (stream: stream.Readable) => {
        stream.on('response', (res: RequestResponse) => {
          scopes.forEach(x => x.done());
          assert.equal('Bearer abc123', res.request.headers.Authorization);
          assert.equal(url.format(res.request.url), REQ_OPTS.url + queryPath);
          done();
        });
      });
    });

    it('should set userProject', (done) => {
      const scopes = [
        mockAuthorizeRequest(), nock(REQ_OPTS.url).get(queryPath).reply(200)
      ];
      up.getRequestStream(REQ_OPTS, (stream: stream.Readable) => {
        stream.on('response', (res: RequestResponse) => {
          scopes.forEach(x => x.done());
          assert.deepEqual(res.request.params, {userProject: USER_PROJECT});
          done();
        });
      });
    });

    it('should destroy the stream if an error occurred', (done) => {
      up.destroy = (err: Error) => {
        assert.equal(
            err.message,
            'Could not authenticate request\nRequest failed with status code 500');
        done();
      };
      const scope = mockAuthorizeRequest(500);
      up.getRequestStream(REQ_OPTS, (stream: stream.Readable) => {
        scope.done();
      });
    });

    it('should make the correct request', (done) => {
      mockAuthorizeRequest();
      const scope =
          nock(REQ_OPTS.url).get(queryPath).replyWithFile(200, dawPath);
      up.getRequestStream(REQ_OPTS, (requestStream: stream.Readable) => {
        assert(requestStream);
        setImmediate(done);
        return through();
      });
    });

    it('should set the callback to a noop', (done) => {
      mockAuthorizeRequest();
      const scope = nock(REQ_OPTS.url).get(queryPath).reply(200);
      up.getRequestStream(
          REQ_OPTS, (requestStream: stream.Readable&{callback: Function}) => {
            assert.strictEqual(requestStream.callback.toString(), '() => { }');
            done();
          });
    });

    it('should destroy the stream if there was an error', (done) => {
      mockAuthorizeRequest();
      const scope = nock(REQ_OPTS.url).get(queryPath).reply(200);
      up.getRequestStream(REQ_OPTS, (requestStream: stream.Readable) => {
        const error = new Error(':(');
        up.on('error', (err: Error) => {
          assert.strictEqual(err, error);
          done();
        });
        requestStream.emit('error', error);
      });
    });

    it('should destroy the stream if there was a body error', (done) => {
      const response = {error: '🤮'};
      const scopes = [
        mockAuthorizeRequest(),
        nock(REQ_OPTS.url).get(queryPath).reply(200, response)
      ];
      up.getRequestStream(REQ_OPTS, (requestStream: stream.Readable) => {
        up.on('error', (err: Error) => {
          assert.strictEqual(err, response.error);
          done();
        });
      });
    });

    it('should check if it should retry on response', (done) => {
      let fired = false;
      const res = {status: 200};
      const scopes = [
        mockAuthorizeRequest(), nock(REQ_OPTS.url).get(queryPath).reply(200)
      ];
      up.onResponse = function(resp: RequestResponse) {
        if (!fired) {
          assert.strictEqual(this, up);
          assert.strictEqual(resp, res);
          fired = true;
          done();
        }
      };

      up.getRequestStream(REQ_OPTS, (requestStream: stream.Readable) => {
        requestStream.emit('response', res);
      });
    });

    it('should execute the callback with the stream', (done) => {
      const scopes = [
        mockAuthorizeRequest(), nock(REQ_OPTS.url).get(queryPath).reply(200, {})
      ];
      up.getRequestStream(REQ_OPTS, (reqStream: stream.Readable) => {
        reqStream.on('complete', () => {
          scopes.forEach(x => x.done());
          done();
        });
      });
    });
  });

  describe('#restart', () => {
    beforeEach(() => {
      up.createURI = () => {};
    });

    it('should set numBytesWritten to 0', () => {
      up.numBytesWritten = 8;
      up.restart();
      assert.strictEqual(up.numBytesWritten, 0);
    });

    it('should delete the config', (done) => {
      up.deleteConfig = done;
      up.restart();
    });

    describe('starting a new upload', () => {
      it('should create a new URI', (done) => {
        up.createURI = () => {
          done();
        };

        up.restart();
      });

      it('should destroy stream if it cannot create a URI', (done) => {
        const error = new Error(':(');

        up.createURI = (callback: Function) => {
          callback(error);
        };

        up.destroy = (err: Error) => {
          assert.strictEqual(err, error);
          done();
        };

        up.restart();
      });

      it('should start uploading', (done) => {
        up.createURI = (callback: Function) => {
          up.startUploading = done;
          callback();
        };

        up.restart();
      });
    });
  });

  describe('#get', () => {
    it('should return the value from the config store', () => {
      const prop = 'property';
      const value = 'abc';

      up.configStore = {
        get(name: string) {
          const actualKey = [up.bucket, up.file].join('/');
          assert.strictEqual(name, actualKey);

          const obj: {[i: string]: string} = {};
          obj[prop] = value;
          return obj;
        }
      };

      assert.strictEqual(up.get(prop), value);
    });
  });

  describe('#set', () => {
    it('should set the value to the config store', (done) => {
      const props = {setting: true};

      up.configStore = {
        set(name: string, prps: {}) {
          const actualKey = [up.bucket, up.file].join('/');
          assert.strictEqual(name, actualKey);
          assert.strictEqual(prps, props);
          done();
        }
      };

      up.set(props);
    });
  });

  describe('#deleteConfig', () => {
    it('should delete the entry from the config store', (done) => {
      const props = {setting: true};

      up.configStore = {
        delete (name: string) {
          const actualKey = [up.bucket, up.file].join('/');
          assert.strictEqual(name, actualKey);
          done();
        }
      };

      up.deleteConfig(props);
    });
  });

  describe('#onResponse', () => {
    beforeEach(() => {
      up.numRetries = 0;
      up.startUploading = () => {};
      up.continueUploading = () => {};
    });

    describe('404', () => {
      const RESP = {status: 404};

      it('should increase the retry count if less than limit', () => {
        assert.strictEqual(up.numRetries, 0);
        assert.strictEqual(up.onResponse(RESP), false);
        assert.strictEqual(up.numRetries, 1);
      });

      it('should destroy the stream if gte limit', (done) => {
        up.destroy = (err: Error) => {
          assert.strictEqual(err.message, 'Retry limit exceeded');
          done();
        };

        up.onResponse(RESP);
        up.onResponse(RESP);
        up.onResponse(RESP);
        up.onResponse(RESP);
        up.onResponse(RESP);
        up.onResponse(RESP);
      });

      it('should start an upload', (done) => {
        up.startUploading = done;
        up.onResponse(RESP);
      });
    });

    describe('500s', () => {
      const RESP = {status: 500};

      it('should increase the retry count if less than limit', () => {
        assert.strictEqual(up.numRetries, 0);
        assert.strictEqual(up.onResponse(RESP), false);
        assert.strictEqual(up.numRetries, 1);
      });

      it('should destroy the stream if greater than limit', (done) => {
        up.destroy = (err: Error) => {
          assert.strictEqual(err.message, 'Retry limit exceeded');
          done();
        };

        up.onResponse(RESP);
        up.onResponse(RESP);
        up.onResponse(RESP);
        up.onResponse(RESP);
        up.onResponse(RESP);
        up.onResponse(RESP);
      });

      it('should continue uploading after retry count^2 * random', (done) => {
        up.continueUploading = function() {
          assert.strictEqual(this, up);
          // make it keep retrying until the limit is reached
          up.onResponse(RESP);
        };

        const setTimeout = global.setTimeout;
        global.setTimeout = (cb: Function, delay: number) => {
          const minTime = Math.pow(2, up.numRetries - 1) * 1000;
          const maxTime = minTime + 1000;

          assert(delay >= minTime);
          assert(delay <= maxTime);
          cb();
          return {ref() {}, unref() {}};
        };

        up.on('error', (err: Error) => {
          assert.strictEqual(up.numRetries, 5);
          assert.strictEqual(err.message, 'Retry limit exceeded');
          global.setTimeout = setTimeout;
          done();
        });

        up.onResponse(RESP);
      });
    });

    describe('all others', () => {
      const RESP = {status: 200};

      it('should emit the response on the stream', (done) => {
        up.on('response', (resp: RequestResponse) => {
          assert.strictEqual(resp, RESP);
          done();
        });
        up.onResponse(RESP);
      });

      it('should return true', () => {
        assert.strictEqual(up.onResponse(RESP), true);
      });
    });
  });
});
