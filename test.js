'use strict'

var assert = require('assert')
var bufferEqual = require('buffer-equal')
var crypto = require('crypto')
var fs = require('fs')
var isStream = require('is-stream')
var mockery = require('mockery')
var through = require('through2')

var configData = {}
function ConfigStore () {
  this.delete = function (key) { delete configData[key] }
  this.get = function (key) { return configData[key] }
  this.set = function (key, value) { configData[key] = value }
}

var requestMock
var _request = require('request')
var request = function () {
  return (requestMock || function () {}).apply(null, arguments)
}
request.defaults = _request.defaults

describe('gcs-resumable-upload', function () {
  var upload
  var up

  var BUCKET = 'bucket-name'
  var FILE = 'file-name'
  var GENERATION = Date.now()
  var METADATA = {
    contentLength: 1024,
    contentType: 'application/json'
  }
  var ORIGIN = '*'
  var PREDEFINED_ACL = 'authenticatedRead'
  var USER_PROJECT = 'user-project-id'

  before(function () {
    mockery.registerMock('configstore', ConfigStore)
    mockery.registerMock('request', request)

    mockery.enable({
      useCleanCache: true,
      warnOnUnregistered: false
    })

    upload = require('./')
  })

  beforeEach(function () {
    configData = {}
    requestMock = null

    up = upload({
      bucket: BUCKET,
      file: FILE,
      generation: GENERATION,
      metadata: METADATA,
      origin: ORIGIN,
      predefinedAcl: PREDEFINED_ACL,
      userProject: USER_PROJECT
    })
  })

  after(function () {
    mockery.deregisterAll()
    mockery.disable()
  })

  it('should work', function (done) {
    this.timeout(90000)

    var uploadSucceeded = false

    requestMock = _request

    fs.createReadStream('daw.jpg')
      .on('error', done)
      .pipe(upload({
        bucket: 'stephen-has-a-new-bucket',
        file: 'daw.jpg',
        metadata: {
          contentType: 'image/jpg'
        }
      }))
      .on('error', done)
      .on('response', function (resp) {
        uploadSucceeded = resp.statusCode === 200
      })
      .on('finish', function () {
        assert.strictEqual(uploadSucceeded, true)
        done()
      })
  })

  it('should resume an interrupted upload', function (done) {
    this.timeout(90000)

    requestMock = _request

    fs.stat('daw.jpg', function (err, fd) {
      assert.ifError(err)

      var size = fd.size

      var doUpload = function (opts, callback) {
        var sizeStreamed = 0
        var destroyed = false

        var ws = upload({
          bucket: 'stephen-has-a-new-bucket',
          file: 'daw.jpg',
          metadata: {
            contentType: 'image/jpg'
          }
        })

        fs.createReadStream('daw.jpg')
          .on('error', callback)
          .on('data', function (chunk) {
            sizeStreamed += chunk.length

            if (!destroyed && opts.interrupt && sizeStreamed >= size / 2) {
              // stop sending data half way through
              destroyed = true
              this.destroy()
              ws.destroy(new Error('Interrupted'))
            }
          })
          .pipe(ws)
          .on('error', callback)
          .on('metadata', callback.bind(null, null))
      }

      doUpload({ interrupt: true }, function (err) {
        assert.strictEqual(err.message, 'Interrupted')

        doUpload({ interrupt: false }, function (err, metadata) {
          assert.ifError(err)
          assert.equal(metadata.size, size)
          done()
        })
      })
    })
  })

  it('should just make an upload URI', function (done) {
    this.timeout(10000)

    requestMock = _request

    upload.createURI({
      bucket: 'stephen-has-a-new-bucket',
      file: 'daw.jpg',
      metadata: {
        contentType: 'image/jpg'
      }
    }, done)
  })

  describe('ctor', function () {
    it('should throw if a bucket or file is not given', function () {
      assert.throws(function () {
        upload()
      }, 'A bucket and file name are required')
    })

    it('should localize the bucket and file', function () {
      assert.strictEqual(up.bucket, BUCKET)
      assert.strictEqual(up.file, FILE)
    })

    it('should localize the generation', function () {
      assert.strictEqual(up.generation, GENERATION)
    })

    it('should localize metadata or default to empty object', function () {
      assert.strictEqual(up.metadata, METADATA)

      var upWithoutMetadata = upload({ bucket: BUCKET, file: FILE })
      assert.deepEqual(upWithoutMetadata.metadata, {})
    })

    it('should set the offset if it is provided', function () {
      var offset = 10
      var up = upload({ bucket: BUCKET, file: FILE, offset: offset })

      assert.strictEqual(up.offset, offset)
    })

    it('should localize the origin', function () {
      assert.strictEqual(up.origin, ORIGIN)
    })

    it('should localize userProject', function () {
      assert.strictEqual(up.userProject, USER_PROJECT)
    })

    it('should localize an encryption object from a key', function () {
      var key = crypto.randomBytes(32)

      var up = upload({ bucket: BUCKET, file: FILE, key: key })

      var expectedKey = key.toString('base64')
      var expectedHash = crypto.createHash('sha256').update(expectedKey, 'base64').digest('base64')

      assert.deepEqual(up.encryption, {
        key: expectedKey,
        hash: expectedHash
      })
    })

    it('should localize the predefinedAcl', function () {
      assert.strictEqual(up.predefinedAcl, PREDEFINED_ACL)
    })

    it('should set the predefinedAcl with public: true', function () {
      var up = upload({ bucket: BUCKET, file: FILE, public: true })
      assert.strictEqual(up.predefinedAcl, 'publicRead')
    })

    it('should set the predefinedAcl with private: true', function () {
      var up = upload({ bucket: BUCKET, file: FILE, private: true })
      assert.strictEqual(up.predefinedAcl, 'private')
    })

    it('should set numBytesWritten to 0', function () {
      assert.strictEqual(up.numBytesWritten, 0)
    })

    it('should set numRetries to 0', function () {
      assert.strictEqual(up.numRetries, 0)
    })

    it('should set the contentLength if provided', function () {
      var up = upload({ bucket: BUCKET, file: FILE, metadata: { contentLength: METADATA.contentLength } })
      assert.strictEqual(up.contentLength, METADATA.contentLength)
    })

    it('should default the contentLength to *', function () {
      var up = upload({ bucket: BUCKET, file: FILE })
      assert.strictEqual(up.contentLength, '*')
    })

    it('should localize the uri or get one from config', function () {
      var uri = 'http://www.blah.com/'
      var upWithUri = upload({ bucket: BUCKET, file: FILE, uri: uri })
      assert.strictEqual(upWithUri.uriProvidedManually, true)
      assert.strictEqual(upWithUri.uri, uri)

      configData[[BUCKET, FILE].join('/')] = { uri: 'fake-uri' }
      var up = upload({ bucket: BUCKET, file: FILE })
      assert.strictEqual(up.uriProvidedManually, false)
      assert.strictEqual(up.uri, 'fake-uri')
    })

    describe('on write', function () {
      var URI = 'uri'

      it('should continue uploading', function (done) {
        up.uri = URI
        up.continueUploading = done
        up.emit('writing')
      })

      it('should create an upload', function (done) {
        up.startUploading = done

        up.createURI = function (callback) {
          callback()
        }

        up.emit('writing')
      })

      it('should destroy the stream from an error', function (done) {
        var error = new Error(':(')

        up.destroy = function (err) {
          assert(err.message.indexOf(error.message) > -1)
          done()
        }

        up.createURI = function (callback) {
          callback(error)
        }

        up.emit('writing')
      })
    })
  })

  describe('#createURI', function () {
    it('should make the correct request', function (done) {
      up.makeRequest = function (reqOpts) {
        assert.strictEqual(reqOpts.method, 'POST')
        assert.strictEqual(reqOpts.uri, 'https://www.googleapis.com/upload/storage/v1/b/' + BUCKET + '/o')
        assert.deepEqual(reqOpts.qs, {
          predefinedAcl: up.predefinedAcl,
          name: FILE,
          uploadType: 'resumable',
          ifGenerationMatch: GENERATION
        })
        assert.strictEqual(reqOpts.json, up.metadata)
        done()
      }

      up.createURI()
    })

    it('should respect 0 as a generation', function (done) {
      up.makeRequest = function (reqOpts) {
        assert.strictEqual(reqOpts.qs.ifGenerationMatch, 0)
        done()
      }

      up.generation = 0
      up.createURI()
    })

    describe('error', function () {
      var error = new Error(':(')

      beforeEach(function () {
        up.makeRequest = function (reqOpts, callback) {
          callback(error)
        }
      })

      it('should exec callback with error', function (done) {
        up.createURI(function (err) {
          assert.strictEqual(err, error)
          done()
        })
      })
    })

    describe('success', function () {
      var URI = 'uri'
      var RESP = {
        headers: {
          location: URI
        }
      }

      beforeEach(function () {
        up.makeRequest = function (reqOpts, callback) {
          callback(null, RESP)
        }
      })

      it('should localize the uri', function (done) {
        up.createURI(function (err) {
          assert.ifError(err)
          assert.strictEqual(up.uri, URI)
          assert.strictEqual(up.offset, 0)
          done()
        })
      })

      it('should save the uri to config', function (done) {
        up.set = function (props) {
          assert.deepEqual(props, { uri: URI })
          done()
        }

        up.createURI(assert.ifError)
      })

      it('should default the offset to 0', function (done) {
        up.createURI(function (err) {
          assert.ifError(err)
          assert.strictEqual(up.offset, 0)
          done()
        })
      })

      it('should exec callback with URI', function (done) {
        up.createURI(function (err, uri) {
          assert.ifError(err)
          assert.strictEqual(uri, URI)
          done()
        })
      })
    })
  })

  describe('#continueUploading', function () {
    it('should start uploading if an offset was set', function (done) {
      up.offset = 0

      up.startUploading = function () {
        done()
      }

      up.continueUploading()
    })

    it('should get and set offset if no offset was set', function (done) {
      up.getAndSetOffset = function () {
        done()
      }

      up.continueUploading()
    })

    it('should start uploading when done', function (done) {
      up.startUploading = function () {
        assert.strictEqual(this, up)
        done()
      }

      up.getAndSetOffset = function (callback) {
        callback()
      }

      up.continueUploading()
    })
  })

  describe('#startUploading', function () {
    it('should make the correct request', function (done) {
      var URI = 'uri'
      var OFFSET = 8

      up.uri = URI
      up.offset = OFFSET

      up.getRequestStream = function (reqOpts) {
        assert.strictEqual(reqOpts.method, 'PUT')
        assert.strictEqual(reqOpts.uri, up.uri)
        assert.deepEqual(reqOpts.headers, {
          'Content-Range': 'bytes ' + OFFSET + '-*/' + up.contentLength
        })

        done()
      }

      up.startUploading()
    })

    it('should create a buffer stream', function () {
      assert.strictEqual(up.bufferStream, undefined)
      up.startUploading()
      assert.strictEqual(isStream(up.bufferStream), true)
    })

    it('should create an offset stream', function () {
      assert.strictEqual(up.offsetStream, undefined)
      up.startUploading()
      assert.strictEqual(isStream(up.offsetStream), true)
    })

    it('should set the pipeline', function (done) {
      var requestStream = through()

      up.setPipeline = function (buffer, offset, request, delay) {
        assert.strictEqual(buffer, up.bufferStream)
        assert.strictEqual(offset, up.offsetStream)
        assert.strictEqual(request, requestStream)
        assert.strictEqual(isStream(delay), true)

        done()
      }

      up.getRequestStream = function (reqOpts, callback) {
        callback(requestStream)
      }

      up.startUploading()
    })

    it('should cork the stream on prefinish', function (done) {
      up.cork = done

      up.setPipeline = function (buffer, offset, request, delay) {
        setImmediate(function () {
          delay.emit('prefinish')
        })
      }

      up.getRequestStream = function (reqOpts, callback) {
        callback(through())
      }

      up.startUploading()
    })

    it('should emit the metadata', function (done) {
      var BODY = { hi: 1 }
      var RESP = { body: BODY }

      var requestStream = through()

      up.getRequestStream = function (reqOpts, callback) {
        callback(requestStream)

        up.on('metadata', function (body) {
          assert.strictEqual(body, BODY)
          done()
        })

        requestStream.emit('complete', RESP)
      }

      up.startUploading()
    })

    it('should destroy the stream if an error occurred', function (done) {
      var RESP = { body: '', statusCode: 404 }
      var requestStream = through()

      up.getRequestStream = function (reqOpts, callback) {
        callback(requestStream)

        // metadata shouldn't be emitted... will blow up test if called
        up.on('metadata', done)

        up.destroy = function (err) {
          assert.strictEqual(err.message, 'Upload failed')
          done()
        }

        requestStream.emit('complete', RESP)
      }

      up.startUploading()
    })

    it('should delete the config', function (done) {
      var RESP = { body: '' }
      var requestStream = through()

      up.getRequestStream = function (reqOpts, callback) {
        callback(requestStream)
        up.deleteConfig = done
        requestStream.emit('complete', RESP)
      }

      up.startUploading()
    })

    it('should uncork the stream', function (done) {
      var RESP = { body: '' }
      var requestStream = through()

      up.getRequestStream = function (reqOpts, callback) {
        callback(requestStream)
        up.uncork = done
        requestStream.emit('complete', RESP)
      }

      up.startUploading()
    })
  })

  describe('#onChunk', function () {
    var CHUNK = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    var ENC = 'utf-8'
    var NEXT = function () {}

    describe('first write', function () {
      beforeEach(function () {
        up.numBytesWritten = 0
      })

      it('should get the first chunk', function (done) {
        up.get = function (prop) {
          assert.strictEqual(prop, 'firstChunk')
          done()
        }

        up.onChunk(CHUNK, ENC, NEXT)
      })

      describe('new upload', function () {
        beforeEach(function () {
          up.get = function () {}
        })

        it('should save the uri and first chunk if its not cached', function () {
          var URI = 'uri'
          up.uri = URI

          up.set = function (props) {
            var firstChunk = CHUNK.slice(0, 16).valueOf()
            assert.deepEqual(props.uri, URI)
            assert.strictEqual(bufferEqual(props.firstChunk, firstChunk), true)
          }

          up.onChunk(CHUNK, ENC, NEXT)
        })
      })

      describe('continued upload', function () {
        beforeEach(function () {
          up.bufferStream = through()
          up.offsetStream = through()
          up.get = function () { return CHUNK }
        })

        it('should push data back to the buffer stream if different', function (done) {
          up.bufferStream.unshift = function (chunk) {
            assert.strictEqual(chunk, CHUNK)
            done()
          }

          up.onChunk(CHUNK, ENC, NEXT)
        })

        it('should unpipe the offset stream', function (done) {
          up.bufferStream.unpipe = function (stream) {
            assert.strictEqual(stream, up.offsetStream)
            done()
          }

          up.onChunk(CHUNK, ENC, NEXT)
        })

        it('should restart the stream', function (done) {
          up.restart = done

          up.onChunk(CHUNK, ENC, NEXT)
        })
      })
    })

    describe('successive writes', function () {
      it('should increase the length of the bytes written by the bytelength of the chunk', function () {
        assert.strictEqual(up.numBytesWritten, 0)
        up.onChunk(CHUNK, ENC, NEXT)
        assert.strictEqual(up.numBytesWritten, Buffer.byteLength(CHUNK, ENC))
      })

      it('should slice the chunk by the offset - numBytesWritten', function (done) {
        var OFFSET = 8
        up.offset = OFFSET
        up.onChunk(CHUNK, ENC, function (err, chunk) {
          assert.ifError(err)

          var expectedChunk = CHUNK.slice(OFFSET)
          assert.strictEqual(bufferEqual(chunk, expectedChunk), true)
          done()
        })
      })
    })

    describe('next()', function () {
      it('should push data to the stream if the bytes written is > offset', function (done) {
        up.numBytesWritten = 10
        up.offset = 0

        up.onChunk(CHUNK, ENC, function (err, chunk) {
          assert.ifError(err)
          assert.strictEqual(Buffer.isBuffer(chunk), true)
          done()
        })
      })

      it('should not push data to the stream if the bytes written is < offset', function (done) {
        up.numBytesWritten = 0
        up.offset = 1000

        up.onChunk(CHUNK, ENC, function (err, chunk) {
          assert.ifError(err)
          assert.strictEqual(chunk, undefined)
          done()
        })
      })
    })
  })

  describe('#getAndSetOffset', function () {
    var RANGE = 123456

    var RESP = {
      statusCode: 308,
      headers: {
        range: 'range-' + RANGE
      }
    }

    it('should make the correct request', function (done) {
      var URI = 'uri'
      up.uri = URI

      up.makeRequest = function (reqOpts) {
        assert.strictEqual(reqOpts.method, 'PUT')
        assert.strictEqual(reqOpts.uri, URI)
        assert.deepEqual(reqOpts.headers, {
          'Content-Length': 0,
          'Content-Range': 'bytes */*'
        })

        done()
      }

      up.getAndSetOffset()
    })

    describe('restart on 404', function () {
      var ERROR = new Error(':(')
      var RESP = {
        statusCode: 404
      }

      beforeEach(function () {
        up.makeRequest = function (reqOpts, callback) {
          callback(ERROR, RESP)
        }
      })

      it('should restart the upload', function (done) {
        up.restart = done
        up.getAndSetOffset()
      })

      it('should not restart if URI provided manually', function (done) {
        up.uriProvidedManually = true
        up.restart = done // will cause test to fail
        up.on('error', function (err) {
          assert.strictEqual(err, ERROR)
          done()
        })
        up.getAndSetOffset()
      })
    })

    describe('restart on 410', function () {
      var ERROR = new Error(':(')
      var RESP = {
        statusCode: 410
      }

      beforeEach(function () {
        up.makeRequest = function (reqOpts, callback) {
          callback(ERROR, RESP)
        }
      })

      it('should restart the upload', function (done) {
        up.restart = done
        up.getAndSetOffset()
      })
    })

    it('should set the offset from the range', function (done) {
      up.makeRequest = function (reqOpts, callback) {
        callback(null, RESP)
      }

      up.getAndSetOffset(function () {
        assert.strictEqual(up.offset, RANGE + 1)
        done()
      })
    })

    it('should set the offset to 0 if no range is back from the API', function (done) {
      up.makeRequest = function (reqOpts, callback) {
        callback(null, {})
      }

      up.getAndSetOffset(function () {
        assert.strictEqual(up.offset, 0)
        done()
      })
    })
  })

  describe('#makeRequest', function () {
    var REQ_OPTS = { uri: 'http://uri' }

    it('should set encryption headers', function (done) {
      var key = crypto.randomBytes(32)
      var up = upload({ bucket: 'BUCKET', file: FILE, key: key })

      up.authClient = {
        authorizeRequest: function (reqOpts) {
          assert.deepEqual(reqOpts.headers, {
            'x-goog-encryption-algorithm': 'AES256',
            'x-goog-encryption-key': up.encryption.key,
            'x-goog-encryption-key-sha256': up.encryption.hash
          })
          done()
        }
      }

      up.makeRequest(REQ_OPTS)
    })

    it('should set userProject', function (done) {
      up.authClient = {
        authorizeRequest: function (reqOpts) {
          assert.deepEqual(reqOpts.qs, {
            userProject: USER_PROJECT
          })
          done()
        }
      }

      up.makeRequest(REQ_OPTS)
    })

    it('should authorize the request', function (done) {
      up.authClient = {
        authorizeRequest: function (reqOpts) {
          assert.strictEqual(reqOpts, REQ_OPTS)
          done()
        }
      }

      up.makeRequest(REQ_OPTS)
    })

    it('should execute the callback with error & response if one occurred', function (done) {
      var error = new Error(':(')
      var response = {}

      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback(error, response)
        }
      }

      up.makeRequest({}, function (err, resp) {
        assert(err.message.indexOf(error.message) > -1)
        done()
      })
    })

    it('should make the correct request', function (done) {
      var authorizedReqOpts = {
        uri: 'http://uri',
        headers: {},
        json: true
      }

      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback(null, authorizedReqOpts)
        }
      }

      requestMock = function (opts) {
        assert.strictEqual(opts.uri, authorizedReqOpts.uri)
        assert.deepEqual(opts.headers, authorizedReqOpts.headers)
        assert.strictEqual(opts.json, authorizedReqOpts.json)
        done()
      }

      up.makeRequest(REQ_OPTS, function () {})
    })

    it('should execute the callback with error & response', function (done) {
      var error = new Error(':(')
      var response = {}

      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback()
        }
      }

      requestMock = function (opts, callback) {
        callback(error, response)
      }

      up.makeRequest(REQ_OPTS, function (err, resp) {
        assert.strictEqual(err, error)
        assert.strictEqual(resp, response)
        done()
      })
    })

    it('should execute the callback with a body error & response', function (done) {
      var response = {}
      var body = {
        error: new Error(':(')
      }

      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback()
        }
      }

      requestMock = function (opts, callback) {
        callback(null, response, body)
      }

      up.makeRequest({}, function (err, resp) {
        assert.strictEqual(err, body.error)
        assert.strictEqual(resp, response)
        done()
      })
    })

    it('should execute the callback', function (done) {
      var res = { statusCode: 200 }
      var body = 'body'

      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback()
        }
      }

      up.onResponse = function () {
        return true
      }

      requestMock = function (opts, callback) {
        callback(null, res, body)
      }

      up.makeRequest(REQ_OPTS, function (err, resp, bdy) {
        assert.ifError(err)
        assert.strictEqual(resp, res)
        assert.strictEqual(bdy, body)
        done()
      })
    })
  })

  describe('#getRequestStream', function () {
    var REQ_OPTS = { uri: 'http://uri' }

    it('should authorize the request', function (done) {
      up.authClient = {
        authorizeRequest: function (reqOpts) {
          assert.strictEqual(reqOpts, REQ_OPTS)
          done()
        }
      }

      up.getRequestStream(REQ_OPTS)
    })

    it('should set userProject', function (done) {
      up.authClient = {
        authorizeRequest: function (reqOpts) {
          assert.deepEqual(reqOpts.qs, {
            userProject: USER_PROJECT
          })
          done()
        }
      }

      up.getRequestStream(REQ_OPTS)
    })

    it('should destroy the stream if an error occurred', function (done) {
      var error = new Error(':(')

      up.destroy = function (err) {
        assert(err.message.indexOf(error.message) > -1)
        done()
      }

      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback(error)
        }
      }

      up.getRequestStream(REQ_OPTS)
    })

    it('should make the correct request', function (done) {
      var authorizedReqOpts = {
        uri: 'http://uri',
        headers: {},
        json: true
      }

      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback(null, authorizedReqOpts)
        }
      }

      requestMock = function (opts) {
        assert.strictEqual(opts.uri, authorizedReqOpts.uri)
        assert.deepEqual(opts.headers, authorizedReqOpts.headers)
        assert.strictEqual(opts.json, authorizedReqOpts.json)
        setImmediate(done)
        return through()
      }

      up.getRequestStream(REQ_OPTS, function () {})
    })

    it('should set the callback to a noop', function (done) {
      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback()
        }
      }

      requestMock = function () {
        return through()
      }

      up.getRequestStream(REQ_OPTS, function (requestStream) {
        assert.strictEqual(requestStream.callback.toString(), 'function () {}')
        done()
      })
    })

    it('should destroy the stream if there was an error', function (done) {
      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback()
        }
      }

      requestMock = function () {
        return through()
      }

      up.getRequestStream(REQ_OPTS, function (requestStream) {
        var error = new Error(':(')

        up.on('error', function (err) {
          assert.strictEqual(err, error)
          done()
        })

        requestStream.emit('error', error)
      })
    })

    it('should destroy the stream if there was a body error', function (done) {
      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback()
        }
      }

      requestMock = function () {
        return through()
      }

      up.getRequestStream(REQ_OPTS, function (requestStream) {
        var response = {
          body: {
            error: new Error(':(')
          }
        }

        up.on('error', function (err) {
          assert.strictEqual(err, response.body.error)
          done()
        })

        requestStream.emit('complete', response)
      })
    })

    it('should check if it should retry on response', function (done) {
      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback()
        }
      }

      requestMock = function () {
        return through()
      }

      var res = { statusCode: 200 }

      up.onResponse = function (resp) {
        assert.strictEqual(this, up)
        assert.strictEqual(resp, res)
        done()
      }

      up.getRequestStream(REQ_OPTS, function (requestStream) {
        requestStream.emit('response', res)
      })
    })

    it('should execute the callback with the stream', function (done) {
      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback()
        }
      }

      var requestStream = through()

      requestMock = function () {
        return requestStream
      }

      up.getRequestStream(REQ_OPTS, function (reqStream) {
        assert.strictEqual(reqStream, requestStream)
        done()
      })
    })
  })

  describe('#restart', function () {
    it('should set numBytesWritten to 0', function () {
      up.numBytesWritten = 8
      up.restart()
      assert.strictEqual(up.numBytesWritten, 0)
    })

    it('should delete the config', function (done) {
      up.deleteConfig = done
      up.restart()
    })

    describe('starting a new upload', function () {
      it('should create a new URI', function (done) {
        up.createURI = function () {
          done()
        }

        up.restart()
      })

      it('should destroy stream if it cannot create a URI', function (done) {
        var error = new Error(':(')

        up.createURI = function (callback) {
          callback(error)
        }

        up.destroy = function (err) {
          assert.strictEqual(err, error)
          done()
        }

        up.restart()
      })

      it('should start uploading', function (done) {
        up.createURI = function (callback) {
          callback()
        }

        up.startUploading = done

        up.restart()
      })
    })
  })

  describe('#get', function () {
    it('should return the value from the config store', function () {
      var prop = 'property'
      var value = 'abc'

      up.configStore = {
        get: function (name) {
          let actualKey = [up.bucket, up.file].join('/')
          assert.strictEqual(name, actualKey)

          var obj = {}
          obj[prop] = value
          return obj
        }
      }

      assert.strictEqual(up.get(prop), value)
    })
  })

  describe('#set', function () {
    it('should set the value to the config store', function (done) {
      var props = { setting: true }

      up.configStore = {
        set: function (name, prps) {
          let actualKey = [up.bucket, up.file].join('/')
          assert.strictEqual(name, actualKey)
          assert.strictEqual(prps, props)
          done()
        }
      }

      up.set(props)
    })
  })

  describe('#deleteConfig', function () {
    it('should delete the entry from the config store', function (done) {
      var props = { setting: true }

      up.configStore = {
        delete: function (name) {
          let actualKey = [up.bucket, up.file].join('/')
          assert.strictEqual(name, actualKey)
          done()
        }
      }

      up.deleteConfig(props)
    })
  })

  describe('#onResponse', function () {
    beforeEach(function () {
      up.numRetries = 0
      up.startUploading = function () {}
      up.continueUploading = function () {}
    })

    describe('404', function () {
      var RESP = { statusCode: 404 }

      it('should increase the retry count if less than limit', function () {
        assert.strictEqual(up.numRetries, 0)
        assert.strictEqual(up.onResponse(RESP), false)
        assert.strictEqual(up.numRetries, 1)
        assert.strictEqual(up.onResponse(RESP), false)
        assert.strictEqual(up.numRetries, 2)
        assert.strictEqual(up.onResponse(RESP), false)
        assert.strictEqual(up.numRetries, 3)
        assert.strictEqual(up.onResponse(RESP), false)
        assert.strictEqual(up.numRetries, 4)
        assert.strictEqual(up.onResponse(RESP), false)
        assert.strictEqual(up.numRetries, 5)
        assert.strictEqual(up.onResponse(RESP), false)
        assert.strictEqual(up.numRetries, 5) // no increase
      })

      it('should destroy the stream if gte limit', function (done) {
        up.destroy = function (err) {
          assert.strictEqual(err.message, 'Retry limit exceeded')
          done()
        }

        up.onResponse(RESP)
        up.onResponse(RESP)
        up.onResponse(RESP)
        up.onResponse(RESP)
        up.onResponse(RESP)
        up.onResponse(RESP)
      })

      it('should start an upload', function (done) {
        up.startUploading = done
        up.onResponse(RESP)
      })
    })

    describe('500s', function () {
      var RESP = { statusCode: 500 }

      it('should increase the retry count if less than limit', function () {
        assert.strictEqual(up.numRetries, 0)
        assert.strictEqual(up.onResponse(RESP), false)
        assert.strictEqual(up.numRetries, 1)
        assert.strictEqual(up.onResponse(RESP), false)
        assert.strictEqual(up.numRetries, 2)
        assert.strictEqual(up.onResponse(RESP), false)
        assert.strictEqual(up.numRetries, 3)
        assert.strictEqual(up.onResponse(RESP), false)
        assert.strictEqual(up.numRetries, 4)
        assert.strictEqual(up.onResponse(RESP), false)
        assert.strictEqual(up.numRetries, 5)
        assert.strictEqual(up.onResponse(RESP), false)
        assert.strictEqual(up.numRetries, 5) // no increase
      })

      it('should destroy the stream if greater than limit', function (done) {
        up.destroy = function (err) {
          assert.strictEqual(err.message, 'Retry limit exceeded')
          done()
        }

        up.onResponse(RESP)
        up.onResponse(RESP)
        up.onResponse(RESP)
        up.onResponse(RESP)
        up.onResponse(RESP)
        up.onResponse(RESP)
      })

      it('should continue uploading after retry count^2 * random', function (done) {
        up.continueUploading = function () {
          assert.strictEqual(this, up)
          // make it keep retrying until the limit is reached
          up.onResponse(RESP)
        }

        var setTimeout = global.setTimeout
        global.setTimeout = function (cb, delay) {
          var minTime = Math.pow(2, up.numRetries - 1) * 1000
          var maxTime = minTime + 1000

          assert(delay >= minTime)
          assert(delay <= maxTime)
          cb()
        }

        up.on('error', function (err) {
          assert.strictEqual(up.numRetries, 5)
          assert.strictEqual(err.message, 'Retry limit exceeded')
          global.setTimeout = setTimeout
          done()
        })

        up.onResponse(RESP)
      })
    })

    describe('all others', function () {
      var RESP = { statusCode: 200 }

      it('should emit the response on the stream', function (done) {
        up.on('response', function (resp) {
          assert.strictEqual(resp, RESP)
          done()
        })

        up.onResponse(RESP)
      })

      it('should return true', function () {
        assert.strictEqual(up.onResponse(RESP), true)
      })
    })
  })
})
