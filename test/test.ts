import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as isStream from 'is-stream';
import * as mockery from 'mockery';
import * as through from 'through2';
import * as r from 'request';
const bufferEqual = require('buffer-equal');

let configData = {};
function ConfigStore () {
  this.delete = function (key) { delete configData[key]; };
  this.get = function (key) { return configData[key]; };
  this.set = function (key, value) { configData[key] = value; };
}

let requestMock;
const _request = r;
const request = (...args) => {
  return (requestMock || (() => {})).apply(null, args);
};
(request as any).defaults = _request.defaults;

describe('gcs-resumable-upload', function () {
  let upload;
  let up;

  const BUCKET = 'bucket-name';
  const FILE = 'file-name';
  const GENERATION = Date.now();
  const METADATA = {
    contentLength: 1024,
    contentType: 'application/json'
  };
  const ORIGIN = '*';
  const PREDEFINED_ACL = 'authenticatedRead';
  const USER_PROJECT = 'user-project-id';

  before(function () {
    mockery.registerMock('configstore', ConfigStore);
    mockery.registerMock('request', request);

    mockery.enable({
      useCleanCache: true,
      warnOnUnregistered: false
    });

    upload = require('../src');
  });

  beforeEach(function () {
    configData = {};
    requestMock = null;

    up = upload({
      bucket: BUCKET,
      file: FILE,
      generation: GENERATION,
      metadata: METADATA,
      origin: ORIGIN,
      predefinedAcl: PREDEFINED_ACL,
      userProject: USER_PROJECT
    });
  });

  after(function () {
    mockery.deregisterAll();
    mockery.disable();
  });

  it('should just make an upload URI', function (done) {
    this.timeout(10000);

    requestMock = _request;

    upload.createURI({
      bucket: 'stephen-has-a-new-bucket',
      file: 'daw.jpg',
      metadata: {
        contentType: 'image/jpg'
      }
    }, done);
  });

  describe('ctor', function () {
    it('should throw if a bucket or file is not given', function () {
      assert.throws(function () {
        upload();
      }, 'A bucket and file name are required');
    });

    it('should localize the bucket and file', function () {
      assert.strictEqual(up.bucket, BUCKET);
      assert.strictEqual(up.file, FILE);
    });

    it('should localize the generation', function () {
      assert.strictEqual(up.generation, GENERATION);
    });

    it('should localize metadata or default to empty object', function () {
      assert.strictEqual(up.metadata, METADATA);

      const upWithoutMetadata = upload({ bucket: BUCKET, file: FILE });
      assert.deepEqual(upWithoutMetadata.metadata, {});
    });

    it('should set the offset if it is provided', function () {
      const offset = 10;
      const up = upload({ bucket: BUCKET, file: FILE, offset });

      assert.strictEqual(up.offset, offset);
    });

    it('should localize the origin', function () {
      assert.strictEqual(up.origin, ORIGIN);
    });

    it('should localize userProject', function () {
      assert.strictEqual(up.userProject, USER_PROJECT);
    });

    it('should localize an encryption object from a key', function () {
      const key = crypto.randomBytes(32);

      const up = upload({ bucket: BUCKET, file: FILE, key });

      const expectedKey = key.toString('base64');
      const expectedHash = crypto.createHash('sha256').update(expectedKey).digest('base64');

      assert.deepEqual(up.encryption, {
        key: expectedKey,
        hash: expectedHash
      });
    });

    it('should localize the predefinedAcl', function () {
      assert.strictEqual(up.predefinedAcl, PREDEFINED_ACL);
    });

    it('should set the predefinedAcl with public: true', function () {
      const up = upload({ bucket: BUCKET, file: FILE, public: true });
      assert.strictEqual(up.predefinedAcl, 'publicRead');
    });

    it('should set the predefinedAcl with private: true', function () {
      const up = upload({ bucket: BUCKET, file: FILE, private: true });
      assert.strictEqual(up.predefinedAcl, 'private');
    });

    it('should set numBytesWritten to 0', function () {
      assert.strictEqual(up.numBytesWritten, 0);
    });

    it('should set numRetries to 0', function () {
      assert.strictEqual(up.numRetries, 0);
    });

    it('should set the contentLength if provided', function () {
      const up = upload({ bucket: BUCKET, file: FILE, metadata: { contentLength: METADATA.contentLength } });
      assert.strictEqual(up.contentLength, METADATA.contentLength);
    });

    it('should default the contentLength to *', function () {
      const up = upload({ bucket: BUCKET, file: FILE });
      assert.strictEqual(up.contentLength, '*');
    });

    it('should localize the uri or get one from config', function () {
      const uri = 'http://www.blah.com/';
      const upWithUri = upload({ bucket: BUCKET, file: FILE, uri });
      assert.strictEqual(upWithUri.uriProvidedManually, true);
      assert.strictEqual(upWithUri.uri, uri);

      configData[[BUCKET, FILE].join('/')] = { uri: 'fake-uri' };
      const up = upload({ bucket: BUCKET, file: FILE });
      assert.strictEqual(up.uriProvidedManually, false);
      assert.strictEqual(up.uri, 'fake-uri');
    });

    describe('on write', function () {
      const URI = 'uri';

      it('should continue uploading', function (done) {
        up.uri = URI;
        up.continueUploading = done;
        up.emit('writing');
      });

      it('should create an upload', function (done) {
        up.startUploading = done;

        up.createURI = function (callback) {
          callback();
        };

        up.emit('writing');
      });

      it('should destroy the stream from an error', function (done) {
        const error = new Error(':(');

        up.destroy = function (err) {
          assert(err.message.indexOf(error.message) > -1);
          done();
        };

        up.createURI = function (callback) {
          callback(error);
        };

        up.emit('writing');
      });
    });
  });

  describe('#createURI', function () {
    it('should make the correct request', function (done) {
      up.makeRequest = function (reqOpts) {
        assert.strictEqual(reqOpts.method, 'POST');
        assert.strictEqual(reqOpts.uri, 'https://www.googleapis.com/upload/storage/v1/b/' + BUCKET + '/o');
        assert.deepEqual(reqOpts.qs, {
          predefinedAcl: up.predefinedAcl,
          name: FILE,
          uploadType: 'resumable',
          ifGenerationMatch: GENERATION
        });
        assert.strictEqual(reqOpts.json, up.metadata);
        done();
      };

      up.createURI();
    });

    it('should respect 0 as a generation', function (done) {
      up.makeRequest = function (reqOpts) {
        assert.strictEqual(reqOpts.qs.ifGenerationMatch, 0);
        done();
      };

      up.generation = 0;
      up.createURI();
    });

    describe('error', function () {
      const error = new Error(':(');

      beforeEach(function () {
        up.makeRequest = function (reqOpts, callback) {
          callback(error);
        };
      });

      it('should exec callback with error', function (done) {
        up.createURI(function (err) {
          assert.strictEqual(err, error);
          done();
        });
      });
    });

    describe('success', function () {
      const URI = 'uri';
      const RESP = {
        headers: {
          location: URI
        }
      };

      beforeEach(function () {
        up.makeRequest = function (reqOpts, callback) {
          callback(null, RESP);
        };
      });

      it('should localize the uri', function (done) {
        up.createURI(function (err) {
          assert.ifError(err);
          assert.strictEqual(up.uri, URI);
          assert.strictEqual(up.offset, 0);
          done();
        });
      });

      it('should save the uri to config', function (done) {
        up.set = function (props) {
          assert.deepEqual(props, { uri: URI });
          done();
        };

        up.createURI(assert.ifError);
      });

      it('should default the offset to 0', function (done) {
        up.createURI(function (err) {
          assert.ifError(err);
          assert.strictEqual(up.offset, 0);
          done();
        });
      });

      it('should exec callback with URI', function (done) {
        up.createURI(function (err, uri) {
          assert.ifError(err);
          assert.strictEqual(uri, URI);
          done();
        });
      });
    });
  });

  describe('#continueUploading', function () {
    it('should start uploading if an offset was set', function (done) {
      up.offset = 0;

      up.startUploading = function () {
        done();
      };

      up.continueUploading();
    });

    it('should get and set offset if no offset was set', function (done) {
      up.getAndSetOffset = function () {
        done();
      };

      up.continueUploading();
    });

    it('should start uploading when done', function (done) {
      up.startUploading = function () {
        assert.strictEqual(this, up);
        done();
      };

      up.getAndSetOffset = function (callback) {
        callback();
      };

      up.continueUploading();
    });
  });

  describe('#startUploading', function () {
    beforeEach(function () {
      up.getRequestStream = function () {};
    });

    it('should make the correct request', function (done) {
      const URI = 'uri';
      const OFFSET = 8;

      up.uri = URI;
      up.offset = OFFSET;

      up.getRequestStream = function (reqOpts) {
        assert.strictEqual(reqOpts.method, 'PUT');
        assert.strictEqual(reqOpts.uri, up.uri);
        assert.deepEqual(reqOpts.headers, {
          'Content-Range': 'bytes ' + OFFSET + '-*/' + up.contentLength
        });

        done();
      };

      up.startUploading();
    });

    it('should create a buffer stream', function () {
      assert.strictEqual(up.bufferStream, undefined);
      up.startUploading();
      assert.strictEqual(isStream(up.bufferStream), true);
    });

    it('should create an offset stream', function () {
      assert.strictEqual(up.offsetStream, undefined);
      up.startUploading();
      assert.strictEqual(isStream(up.offsetStream), true);
    });

    it('should set the pipeline', function (done) {
      const requestStream = through();

      up.setPipeline = function (buffer, offset, request, delay) {
        assert.strictEqual(buffer, up.bufferStream);
        assert.strictEqual(offset, up.offsetStream);
        assert.strictEqual(request, requestStream);
        assert.strictEqual(isStream(delay), true);

        done();
      };

      up.getRequestStream = function (reqOpts, callback) {
        callback(requestStream);
      };

      up.startUploading();
    });

    it('should cork the stream on prefinish', function (done) {
      up.cork = done;

      up.setPipeline = function (buffer, offset, request, delay) {
        setImmediate(function () {
          delay.emit('prefinish');
        });
      };

      up.getRequestStream = function (reqOpts, callback) {
        callback(through());
      };

      up.startUploading();
    });

    it('should emit the metadata', function (done) {
      const BODY = { hi: 1 };
      const RESP = { body: BODY };

      const requestStream = through();

      up.getRequestStream = function (reqOpts, callback) {
        callback(requestStream);

        up.on('metadata', function (body) {
          assert.strictEqual(body, BODY);
          done();
        });

        requestStream.emit('complete', RESP);
      };

      up.startUploading();
    });

    it('should destroy the stream if an error occurred', function (done) {
      const RESP = { body: '', statusCode: 404 };
      const requestStream = through();

      up.getRequestStream = function (reqOpts, callback) {
        callback(requestStream);

        // metadata shouldn't be emitted... will blow up test if called
        up.on('metadata', done);

        up.destroy = function (err) {
          assert.strictEqual(err.message, 'Upload failed');
          done();
        };

        requestStream.emit('complete', RESP);
      };

      up.startUploading();
    });

    it('should delete the config', function (done) {
      const RESP = { body: '' };
      const requestStream = through();

      up.getRequestStream = function (reqOpts, callback) {
        callback(requestStream);
        up.deleteConfig = done;
        requestStream.emit('complete', RESP);
      };

      up.startUploading();
    });

    it('should uncork the stream', function (done) {
      const RESP = { body: '' };
      const requestStream = through();

      up.getRequestStream = function (reqOpts, callback) {
        callback(requestStream);
        up.uncork = done;
        requestStream.emit('complete', RESP);
      };

      up.startUploading();
    });
  });

  describe('#onChunk', function () {
    const CHUNK = Buffer.from('abcdefghijklmnopqrstuvwxyz');
    const ENC = 'utf-8';
    const NEXT = function () {};

    describe('first write', function () {
      beforeEach(function () {
        up.numBytesWritten = 0;
      });

      it('should get the first chunk', function (done) {
        up.get = function (prop) {
          assert.strictEqual(prop, 'firstChunk');
          done();
        };

        up.onChunk(CHUNK, ENC, NEXT);
      });

      describe('new upload', function () {
        beforeEach(function () {
          up.get = function () {};
        });

        it('should save the uri and first chunk if its not cached', function () {
          const URI = 'uri';
          up.uri = URI;

          up.set = function (props) {
            const firstChunk = CHUNK.slice(0, 16).valueOf();
            assert.deepEqual(props.uri, URI);
            assert.strictEqual(bufferEqual(props.firstChunk, firstChunk), true);
          };

          up.onChunk(CHUNK, ENC, NEXT);
        });
      });

      describe('continued upload', function () {
        beforeEach(function () {
          up.bufferStream = through();
          up.offsetStream = through();
          up.get = function () { return CHUNK; };
          up.restart = function () {};
        });

        it('should push data back to the buffer stream if different', function (done) {
          up.bufferStream.unshift = function (chunk) {
            assert.strictEqual(chunk, CHUNK);
            done();
          };

          up.onChunk(CHUNK, ENC, NEXT);
        });

        it('should unpipe the offset stream', function (done) {
          up.bufferStream.unpipe = function (stream) {
            assert.strictEqual(stream, up.offsetStream);
            done();
          };

          up.onChunk(CHUNK, ENC, NEXT);
        });

        it('should restart the stream', function (done) {
          up.restart = done;

          up.onChunk(CHUNK, ENC, NEXT);
        });
      });
    });

    describe('successive writes', function () {
      it('should increase the length of the bytes written by the bytelength of the chunk', function () {
        assert.strictEqual(up.numBytesWritten, 0);
        up.onChunk(CHUNK, ENC, NEXT);
        assert.strictEqual(up.numBytesWritten, Buffer.byteLength(CHUNK, ENC));
      });

      it('should slice the chunk by the offset - numBytesWritten', function (done) {
        const OFFSET = 8;
        up.offset = OFFSET;
        up.onChunk(CHUNK, ENC, function (err, chunk) {
          assert.ifError(err);

          const expectedChunk = CHUNK.slice(OFFSET);
          assert.strictEqual(bufferEqual(chunk, expectedChunk), true);
          done();
        });
      });
    });

    describe('next()', function () {
      it('should push data to the stream if the bytes written is > offset', function (done) {
        up.numBytesWritten = 10;
        up.offset = 0;

        up.onChunk(CHUNK, ENC, function (err, chunk) {
          assert.ifError(err);
          assert.strictEqual(Buffer.isBuffer(chunk), true);
          done();
        });
      });

      it('should not push data to the stream if the bytes written is < offset', function (done) {
        up.numBytesWritten = 0;
        up.offset = 1000;

        up.onChunk(CHUNK, ENC, function (err, chunk) {
          assert.ifError(err);
          assert.strictEqual(chunk, undefined);
          done();
        });
      });
    });
  });

  describe('#getAndSetOffset', function () {
    const RANGE = 123456;

    const RESP = {
      statusCode: 308,
      headers: {
        range: 'range-' + RANGE
      }
    };

    it('should make the correct request', function (done) {
      const URI = 'uri';
      up.uri = URI;

      up.makeRequest = function (reqOpts) {
        assert.strictEqual(reqOpts.method, 'PUT');
        assert.strictEqual(reqOpts.uri, URI);
        assert.deepEqual(reqOpts.headers, {
          'Content-Length': 0,
          'Content-Range': 'bytes */*'
        });

        done();
      };

      up.getAndSetOffset();
    });

    describe('restart on 404', function () {
      const ERROR = new Error(':(');
      const RESP = {
        statusCode: 404
      };

      beforeEach(function () {
        up.makeRequest = function (reqOpts, callback) {
          callback(ERROR, RESP);
        };
      });

      it('should restart the upload', function (done) {
        up.restart = done;
        up.getAndSetOffset();
      });

      it('should not restart if URI provided manually', function (done) {
        up.uriProvidedManually = true;
        up.restart = done; // will cause test to fail
        up.on('error', function (err) {
          assert.strictEqual(err, ERROR);
          done();
        });
        up.getAndSetOffset();
      });
    });

    describe('restart on 410', function () {
      const ERROR = new Error(':(');
      const RESP = {
        statusCode: 410
      };

      beforeEach(function () {
        up.makeRequest = function (reqOpts, callback) {
          callback(ERROR, RESP);
        };
      });

      it('should restart the upload', function (done) {
        up.restart = done;
        up.getAndSetOffset();
      });
    });

    it('should set the offset from the range', function (done) {
      up.makeRequest = function (reqOpts, callback) {
        callback(null, RESP);
      };

      up.getAndSetOffset(function () {
        assert.strictEqual(up.offset, RANGE + 1);
        done();
      });
    });

    it('should set the offset to 0 if no range is back from the API', function (done) {
      up.makeRequest = function (reqOpts, callback) {
        callback(null, {});
      };

      up.getAndSetOffset(function () {
        assert.strictEqual(up.offset, 0);
        done();
      });
    });
  });

  describe('#makeRequest', function () {
    const REQ_OPTS = { uri: 'http://uri' };

    it('should set encryption headers', function (done) {
      const key = crypto.randomBytes(32);
      const up = upload({ bucket: 'BUCKET', file: FILE, key });

      up.authClient = {
        authorizeRequest (reqOpts) {
          assert.deepEqual(reqOpts.headers, {
            'x-goog-encryption-algorithm': 'AES256',
            'x-goog-encryption-key': up.encryption.key,
            'x-goog-encryption-key-sha256': up.encryption.hash
          });
          done();
        }
      };

      up.makeRequest(REQ_OPTS);
    });

    it('should set userProject', function (done) {
      up.authClient = {
        authorizeRequest (reqOpts) {
          assert.deepEqual(reqOpts.qs, {
            userProject: USER_PROJECT
          });
          done();
        }
      };

      up.makeRequest(REQ_OPTS);
    });

    it('should authorize the request', function (done) {
      up.authClient = {
        authorizeRequest (reqOpts) {
          assert.strictEqual(reqOpts, REQ_OPTS);
          done();
        }
      };

      up.makeRequest(REQ_OPTS);
    });

    it('should execute the callback with error & response if one occurred', function (done) {
      const error = new Error(':(');
      const response = {};

      up.authClient = {
        authorizeRequest (reqOpts, callback) {
          callback(error, response);
        }
      };

      up.makeRequest({}, function (err, resp) {
        assert(err.message.indexOf(error.message) > -1);
        done();
      });
    });

    it('should make the correct request', function (done) {
      const authorizedReqOpts = {
        uri: 'http://uri',
        headers: {},
        json: true
      };

      up.authClient = {
        authorizeRequest (reqOpts, callback) {
          callback(null, authorizedReqOpts);
        }
      };

      requestMock = function (opts) {
        assert.strictEqual(opts.uri, authorizedReqOpts.uri);
        assert.deepEqual(opts.headers, authorizedReqOpts.headers);
        assert.strictEqual(opts.json, authorizedReqOpts.json);
        done();
      };

      up.makeRequest(REQ_OPTS, function () {});
    });

    it('should execute the callback with error & response', function (done) {
      const error = new Error(':(');
      const response = {};

      up.authClient = {
        authorizeRequest (reqOpts, callback) {
          callback();
        }
      };

      requestMock = function (opts, callback) {
        callback(error, response);
      };

      up.makeRequest(REQ_OPTS, function (err, resp) {
        assert.strictEqual(err, error);
        assert.strictEqual(resp, response);
        done();
      });
    });

    it('should execute the callback with a body error & response', function (done) {
      const response = {};
      const body = {
        error: new Error(':(')
      };

      up.authClient = {
        authorizeRequest (reqOpts, callback) {
          callback();
        }
      };

      requestMock = function (opts, callback) {
        callback(null, response, body);
      };

      up.makeRequest({}, function (err, resp) {
        assert.strictEqual(err, body.error);
        assert.strictEqual(resp, response);
        done();
      });
    });

    it('should execute the callback', function (done) {
      const res = { statusCode: 200 };
      const body = 'body';

      up.authClient = {
        authorizeRequest (reqOpts, callback) {
          callback();
        }
      };

      up.onResponse = function () {
        return true;
      };

      requestMock = function (opts, callback) {
        callback(null, res, body);
      };

      up.makeRequest(REQ_OPTS, function (err, resp, bdy) {
        assert.ifError(err);
        assert.strictEqual(resp, res);
        assert.strictEqual(bdy, body);
        done();
      });
    });
  });

  describe('#getRequestStream', function () {
    const REQ_OPTS = { uri: 'http://uri' };

    it('should authorize the request', function (done) {
      up.authClient = {
        authorizeRequest (reqOpts) {
          assert.strictEqual(reqOpts, REQ_OPTS);
          done();
        }
      };

      up.getRequestStream(REQ_OPTS);
    });

    it('should set userProject', function (done) {
      up.authClient = {
        authorizeRequest (reqOpts) {
          assert.deepEqual(reqOpts.qs, {
            userProject: USER_PROJECT
          });
          done();
        }
      };

      up.getRequestStream(REQ_OPTS);
    });

    it('should destroy the stream if an error occurred', function (done) {
      const error = new Error(':(');

      up.destroy = function (err) {
        assert(err.message.indexOf(error.message) > -1);
        done();
      };

      up.authClient = {
        authorizeRequest (reqOpts, callback) {
          callback(error);
        }
      };

      up.getRequestStream(REQ_OPTS);
    });

    it('should make the correct request', function (done) {
      const authorizedReqOpts = {
        uri: 'http://uri',
        headers: {},
        json: true
      };

      up.authClient = {
        authorizeRequest (reqOpts, callback) {
          callback(null, authorizedReqOpts);
        }
      };

      requestMock = function (opts) {
        assert.strictEqual(opts.uri, authorizedReqOpts.uri);
        assert.deepEqual(opts.headers, authorizedReqOpts.headers);
        assert.strictEqual(opts.json, authorizedReqOpts.json);
        setImmediate(done);
        return through();
      };

      up.getRequestStream(REQ_OPTS, function () {});
    });

    it('should set the callback to a noop', function (done) {
      up.authClient = {
        authorizeRequest (reqOpts, callback) {
          callback();
        }
      };

      requestMock = function () {
        return through();
      };

      up.getRequestStream(REQ_OPTS, function (requestStream) {
        assert.strictEqual(requestStream.callback.toString(), 'function () { }');
        done();
      });
    });

    it('should destroy the stream if there was an error', function (done) {
      up.authClient = {
        authorizeRequest (reqOpts, callback) {
          callback();
        }
      };

      requestMock = function () {
        return through();
      };

      up.getRequestStream(REQ_OPTS, function (requestStream) {
        const error = new Error(':(');

        up.on('error', function (err) {
          assert.strictEqual(err, error);
          done();
        });

        requestStream.emit('error', error);
      });
    });

    it('should destroy the stream if there was a body error', function (done) {
      up.authClient = {
        authorizeRequest (reqOpts, callback) {
          callback();
        }
      };

      requestMock = function () {
        return through();
      };

      up.getRequestStream(REQ_OPTS, function (requestStream) {
        const response = {
          body: {
            error: new Error(':(')
          }
        };

        up.on('error', function (err) {
          assert.strictEqual(err, response.body.error);
          done();
        });

        requestStream.emit('complete', response);
      });
    });

    it('should check if it should retry on response', function (done) {
      up.authClient = {
        authorizeRequest (reqOpts, callback) {
          callback();
        }
      };

      requestMock = function () {
        return through();
      };

      const res = { statusCode: 200 };

      up.onResponse = function (resp) {
        assert.strictEqual(this, up);
        assert.strictEqual(resp, res);
        done();
      };

      up.getRequestStream(REQ_OPTS, function (requestStream) {
        requestStream.emit('response', res);
      });
    });

    it('should execute the callback with the stream', function (done) {
      up.authClient = {
        authorizeRequest (reqOpts, callback) {
          callback();
        }
      };

      const requestStream = through();

      requestMock = function () {
        return requestStream;
      };

      up.getRequestStream(REQ_OPTS, function (reqStream) {
        assert.strictEqual(reqStream, requestStream);
        done();
      });
    });
  });

  describe('#restart', function () {
    beforeEach(function () {
      up.createURI = function () {};
    });

    it('should set numBytesWritten to 0', function () {
      up.numBytesWritten = 8;
      up.restart();
      assert.strictEqual(up.numBytesWritten, 0);
    });

    it('should delete the config', function (done) {
      up.deleteConfig = done;
      up.restart();
    });

    describe('starting a new upload', function () {
      it('should create a new URI', function (done) {
        up.createURI = function () {
          done();
        };

        up.restart();
      });

      it('should destroy stream if it cannot create a URI', function (done) {
        const error = new Error(':(');

        up.createURI = function (callback) {
          callback(error);
        };

        up.destroy = function (err) {
          assert.strictEqual(err, error);
          done();
        };

        up.restart();
      });

      it('should start uploading', function (done) {
        up.createURI = function (callback) {
          up.startUploading = done;
          callback();
        };

        up.restart();
      });
    });
  });

  describe('#get', function () {
    it('should return the value from the config store', function () {
      const prop = 'property';
      const value = 'abc';

      up.configStore = {
        get (name) {
          const actualKey = [up.bucket, up.file].join('/');
          assert.strictEqual(name, actualKey);

          const obj = {};
          obj[prop] = value;
          return obj;
        }
      };

      assert.strictEqual(up.get(prop), value);
    });
  });

  describe('#set', function () {
    it('should set the value to the config store', function (done) {
      const props = { setting: true };

      up.configStore = {
        set (name, prps) {
          const actualKey = [up.bucket, up.file].join('/');
          assert.strictEqual(name, actualKey);
          assert.strictEqual(prps, props);
          done();
        }
      };

      up.set(props);
    });
  });

  describe('#deleteConfig', function () {
    it('should delete the entry from the config store', function (done) {
      const props = { setting: true };

      up.configStore = {
        delete (name) {
          const actualKey = [up.bucket, up.file].join('/');
          assert.strictEqual(name, actualKey);
          done();
        }
      };

      up.deleteConfig(props);
    });
  });

  describe('#onResponse', function () {
    beforeEach(function () {
      up.numRetries = 0;
      up.startUploading = function () {};
      up.continueUploading = function () {};
    });

    describe('404', function () {
      const RESP = { statusCode: 404 };

      it('should increase the retry count if less than limit', function () {
        assert.strictEqual(up.numRetries, 0);
        assert.strictEqual(up.onResponse(RESP), false);
        assert.strictEqual(up.numRetries, 1);
      });

      it('should destroy the stream if gte limit', function (done) {
        up.destroy = function (err) {
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

      it('should start an upload', function (done) {
        up.startUploading = done;
        up.onResponse(RESP);
      });
    });

    describe('500s', function () {
      const RESP = { statusCode: 500 };

      it('should increase the retry count if less than limit', function () {
        assert.strictEqual(up.numRetries, 0);
        assert.strictEqual(up.onResponse(RESP), false);
        assert.strictEqual(up.numRetries, 1);
      });

      it('should destroy the stream if greater than limit', function (done) {
        up.destroy = function (err) {
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

      it('should continue uploading after retry count^2 * random', function (done) {
        up.continueUploading = function () {
          assert.strictEqual(this, up);
          // make it keep retrying until the limit is reached
          up.onResponse(RESP);
        };

        const setTimeout = global.setTimeout;
        (global as any).setTimeout = function (cb, delay) {
          const minTime = Math.pow(2, up.numRetries - 1) * 1000;
          const maxTime = minTime + 1000;

          assert(delay >= minTime);
          assert(delay <= maxTime);
          cb();
        };

        up.on('error', function (err) {
          assert.strictEqual(up.numRetries, 5);
          assert.strictEqual(err.message, 'Retry limit exceeded');
          global.setTimeout = setTimeout;
          done();
        });

        up.onResponse(RESP);
      });
    });

    describe('all others', function () {
      const RESP = { statusCode: 200 };

      it('should emit the response on the stream', function (done) {
        up.on('response', function (resp) {
          assert.strictEqual(resp, RESP);
          done();
        });

        up.onResponse(RESP);
      });

      it('should return true', function () {
        assert.strictEqual(up.onResponse(RESP), true);
      });
    });
  });
});
