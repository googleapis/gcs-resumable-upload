'use strict'

var assert = require('assert')
var bufferEqual = require('buffer-equal')
var fs = require('fs')
var isStream = require('is-stream')
var mockery = require('mockery')
var through = require('through2')

var configData = {}
function ConfigStore () {
  this.del = function (key) { delete configData[key] }
  this.get = function (key) { return configData[key] }
  this.set = function (key, value) { configData[key] = value }
}

var requestMock
var _request = require('request')
var request = function () {
  return (requestMock || function () {}).apply(null, arguments)
}

describe('gcs-resumable-upload', function () {
  var upload
  var up

  var BUCKET = 'bucket-name'
  var FILE = 'file-name'
  var GENERATION = Date.now()
  var METADATA = { contentType: 'application/json' }

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
      metadata: METADATA
    })
  })

  after(function () {
    mockery.deregisterAll()
    mockery.disable()
  })

  it('should work', function (done) {
    this.timeout(10000)

    var uploadSucceeded = false

    requestMock = _request

    fs.createReadStream('daw.jpg')
      .on('error', done)
      .pipe(upload({
        bucket: 'stephen-has-a-new-bucket',
        file: 'daw.jpg',
        metadata: {
          contentType: 'image/jpg'
        },
        authConfig: {
          credentials: require('./key.json')
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

  it('should just make an upload URI', function (done) {
    requestMock = _request

    upload.createURI({
      bucket: 'stephen-has-a-new-bucket',
      file: 'daw.jpg',
      authConfig: {
        credentials: require('./key.json')
      },
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

    it('should set numBytesWritten to 0', function () {
      assert.strictEqual(up.numBytesWritten, 0)
    })

    it('should set numRetries to 0', function () {
      assert.strictEqual(up.numRetries, 0)
    })

    it('should localize the uri or get one from config', function () {
      var uri = 'http://www.blah.com/'
      var upWithUri = upload({ bucket: BUCKET, file: FILE, uri: uri })
      assert.strictEqual(upWithUri.uri, uri)

      configData[FILE] = { uri: 'fake-uri' }
      var up = upload({ bucket: BUCKET, file: FILE })
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

      it('should localize the uri', function (done) {
        up.startUploading = function () {
          assert.strictEqual(up.uri, URI)
          done()
        }

        up.createURI = function (callback) {
          callback(null, URI)
        }

        up.emit('writing')
      })

      it('should save the uri to config', function (done) {
        up.set = function (props) {
          assert.deepEqual(props, { uri: URI })
          done()
        }

        up.createURI = function (callback) {
          callback(null, URI)
        }

        up.emit('writing')
      })

      it('should set the offset 0', function (done) {
        up.startUploading = function () {
          assert.strictEqual(up.offset, 0)
          done()
        }

        up.createURI = function (callback) {
          callback(null, URI)
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
          name: FILE,
          uploadType: 'resumable',
          ifGenerationMatch: GENERATION
        })
        assert.strictEqual(reqOpts.json, up.metadata)
        assert.deepEqual(reqOpts.headers, {
          'X-Upload-Content-Type': METADATA.contentType
        })

        done()
      }

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
    it('should get and set offset', function (done) {
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
          'Content-Range': 'bytes ' + OFFSET + '-*/*'
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

    it('should emit the response and body', function (done) {
      var BODY = { hi: 1 }
      var RESP = {
        body: JSON.stringify(BODY)
      }

      var requestStream = through()

      up.getRequestStream = function (reqOpts, callback) {
        callback(requestStream)

        up.on('response', function (resp, body) {
          assert.strictEqual(resp, RESP)
          assert.deepEqual(body, BODY)
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
    var CHUNK = new Buffer('abcdefghijklmnopqrstuvwxyz')
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

    it('should authorize the request', function (done) {
      up.authClient = {
        authorizeRequest: function (reqOpts) {
          assert.strictEqual(reqOpts, REQ_OPTS)
          done()
        }
      }

      up.makeRequest(REQ_OPTS)
    })

    it('should execute the callback with error if one occurred', function (done) {
      var error = new Error(':(')

      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback(error)
        }
      }

      up.makeRequest({}, function (err) {
        assert(err.message.indexOf(error.message) > -1)
        done()
      })
    })

    it('should make the correct request', function (done) {
      var authorizedReqOpts = { uri: 'http://uri', headers: {} }

      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback(null, authorizedReqOpts)
        }
      }

      requestMock = function (opts) {
        assert.strictEqual(opts, authorizedReqOpts)
        done()
      }

      up.makeRequest(REQ_OPTS, function () {})
    })

    it('should destroy the stream if there was an error', function (done) {
      var error = new Error(':(')

      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback()
        }
      }

      requestMock = function (opts, callback) {
        callback(error, {})
      }

      up.makeRequest(REQ_OPTS, function (err) {
        assert.strictEqual(err, error)
        done()
      })
    })

    it('should execute the callback', function (done) {
      var res = {}
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

      up.getRequestStream()
    })

    it('should make the correct request', function (done) {
      var authorizedReqOpts = { uri: 'http://uri', headers: {} }

      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback(null, authorizedReqOpts)
        }
      }

      requestMock = function (opts) {
        assert.strictEqual(opts, authorizedReqOpts)
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

    it('should check if it should retry on response', function (done) {
      up.authClient = {
        authorizeRequest: function (reqOpts, callback) {
          callback()
        }
      }

      requestMock = function () {
        return through()
      }

      var res = {}

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

    it('should start uploading', function (done) {
      up.startUploading = done
      up.restart()
    })
  })

  describe('#get', function () {
    it('should return the value from the config store', function () {
      var prop = 'property'
      var value = 'abc'

      up.configStore = {
        get: function (name) {
          assert.strictEqual(name, up.file)

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
          assert.strictEqual(name, up.file)
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
        del: function (name) {
          assert.strictEqual(name, up.file)
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
  })
})
