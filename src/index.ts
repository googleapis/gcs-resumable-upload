import * as crypto from 'crypto';
import * as ConfigStore from 'configstore';
const bufferEqual = require('buffer-equal');
const googleAuth = require('google-auto-auth');
const Pumpify = require('pumpify');

import * as r from 'request';
const request = r.defaults({
  json: true,
  pool: {
    maxSockets: Infinity
  }
});
const StreamEvents = require('stream-events');
const through = require('through2');
const util = require('util');

const BASE_URI = 'https://www.googleapis.com/upload/storage/v1/b';
const TERMINATED_UPLOAD_STATUS_CODE = 410;
const RESUMABLE_INCOMPLETE_STATUS_CODE = 308;
const RETRY_LIMIT = 5;

const wrapError = function (message, err) {
  return new Error([message, err.message].join('\n'));
};

function Upload (cfg) {

  Pumpify.call(this);
  StreamEvents.call(this);

  const self = this;
  cfg = cfg || {};

  if (!cfg.bucket || !cfg.file) {
    throw new Error('A bucket and file name are required');
  }

  cfg.authConfig = cfg.authConfig || {};
  cfg.authConfig.scopes = ['https://www.googleapis.com/auth/devstorage.full_control'];
  this.authClient = cfg.authClient || googleAuth(cfg.authConfig);

  this.bucket = cfg.bucket;
  this.file = cfg.file;
  this.generation = cfg.generation;
  this.metadata = cfg.metadata || {};
  this.offset = cfg.offset;
  this.origin = cfg.origin;
  this.userProject = cfg.userProject;

  if (cfg.key) {
    const base64Key = Buffer.from(cfg.key).toString('base64');
    this.encryption = {
      key: base64Key,
      hash: crypto.createHash('sha256').update(base64Key).digest('base64')
    };
  }

  this.predefinedAcl = cfg.predefinedAcl;
  if (cfg.private) this.predefinedAcl = 'private';
  if (cfg.public) this.predefinedAcl = 'publicRead';

  this.configStore = new ConfigStore('gcs-resumable-upload');
  this.uriProvidedManually = !!cfg.uri;
  this.uri = cfg.uri || this.get('uri');
  this.numBytesWritten = 0;
  this.numRetries = 0;

  const contentLength = cfg.metadata ? parseInt(cfg.metadata.contentLength, 10) : NaN;
  this.contentLength = isNaN(contentLength) ? '*' : contentLength;

  this.once('writing', function () {
    if (self.uri) {
      self.continueUploading();
    } else {
      self.createURI(function (err) {
        if (err) return self.destroy(err);
        self.startUploading();
      });
    }
  });
}

util.inherits(Upload, Pumpify);

Upload.prototype.createURI = function (callback) {
  const self = this;
  const metadata = this.metadata;

  const reqOpts: r.Options = {
    method: 'POST',
    uri: [BASE_URI, this.bucket, 'o'].join('/'),
    qs: {
      name: this.file,
      uploadType: 'resumable'
    },
    json: metadata,
    headers: {}
  };

  if (metadata.contentLength) {
    reqOpts.headers!['X-Upload-Content-Length'] = metadata.contentLength;
  }

  if (metadata.contentType) {
    reqOpts.headers!['X-Upload-Content-Type'] = metadata.contentType;
  }

  if (typeof this.generation !== 'undefined') {
    reqOpts.qs.ifGenerationMatch = this.generation;
  }

  if (this.predefinedAcl) {
    reqOpts.qs.predefinedAcl = this.predefinedAcl;
  }

  if (this.origin) {
    reqOpts.headers!.Origin = this.origin;
  }

  this.makeRequest(reqOpts, function (err, resp) {
    if (err) return callback(err);

    const uri = resp.headers.location;
    self.uri = uri;
    self.set({ uri });
    self.offset = 0;

    callback(null, uri);
  });
};

Upload.prototype.continueUploading = function () {
  if (typeof this.offset === 'number') return this.startUploading();
  this.getAndSetOffset(this.startUploading.bind(this));
};

Upload.prototype.startUploading = function () {
  const self = this;

  const reqOpts = {
    method: 'PUT',
    uri: this.uri,
    headers: {
      'Content-Range': 'bytes ' + this.offset + '-*/' + this.contentLength
    }
  };

  const bufferStream = this.bufferStream = through();
  const offsetStream = this.offsetStream = through(this.onChunk.bind(this));
  const delayStream = through();

  this.getRequestStream(reqOpts, function (requestStream) {
    self.setPipeline(bufferStream, offsetStream, requestStream, delayStream);

    // wait for "complete" from request before letting the stream finish
    delayStream.on('prefinish', function () { self.cork(); });

    requestStream.on('complete', function (resp) {
      if (resp.statusCode < 200 || resp.statusCode > 299) {
        self.destroy(new Error('Upload failed'));
        return;
      }

      self.emit('metadata', resp.body);

      self.deleteConfig();
      self.uncork();
    });
  });
};

Upload.prototype.onChunk = function (chunk, enc, next) {
  const offset = this.offset;
  const numBytesWritten = this.numBytesWritten;

  // check if this is the same content uploaded previously. this caches a slice
  // of the first chunk, then compares it with the first byte of incoming data
  if (numBytesWritten === 0) {
    let cachedFirstChunk = this.get('firstChunk');
    let firstChunk = chunk.slice(0, 16).valueOf();

    if (!cachedFirstChunk) {
      // This is a new upload. Cache the first chunk.
      this.set({
        uri: this.uri,
        firstChunk
      });
    } else {
      // this continues an upload in progress. check if the bytes are the same
      cachedFirstChunk = Buffer.from(cachedFirstChunk);
      firstChunk = Buffer.from(firstChunk);

      if (!bufferEqual(cachedFirstChunk, firstChunk)) {
        // this data is not the same. start a new upload
        this.bufferStream.unshift(chunk);
        this.bufferStream.unpipe(this.offsetStream);
        this.restart();
        return;
      }
    }
  }

  let length = chunk.length;

  if (typeof chunk === 'string') length = Buffer.byteLength(chunk, enc);
  if (numBytesWritten < offset) chunk = chunk.slice(offset - numBytesWritten);

  this.numBytesWritten += length;

  // only push data from the byte after the one we left off on
  next(null, this.numBytesWritten > offset ? chunk : undefined);
};

Upload.prototype.getAndSetOffset = function (callback) {
  const self = this;

  this.makeRequest({
    method: 'PUT',
    uri: this.uri,
    headers: {
      'Content-Length': 0,
      'Content-Range': 'bytes */*'
    }
  }, function (err, resp) {
    if (err) {
      // we don't return a 404 to the user if they provided the resumable URI.
      // if we're just using the configstore file to tell us that this file
      // exists, and it turns out that it doesn't (the 404), that's probably
      // stale config data.
      if (resp && resp.statusCode === 404 && !self.uriProvidedManually) return self.restart();

      // this resumable upload is unrecoverable (bad data or service error).
      //  - https://github.com/stephenplusplus/gcs-resumable-upload/issues/15
      //  - https://github.com/stephenplusplus/gcs-resumable-upload/pull/16#discussion_r80363774
      if (resp && resp.statusCode === TERMINATED_UPLOAD_STATUS_CODE) return self.restart();

      return self.destroy(err);
    }

    if (resp.statusCode === RESUMABLE_INCOMPLETE_STATUS_CODE) {
      if (resp.headers.range) {
        self.offset = parseInt(resp.headers.range.split('-')[1], 10) + 1;
        callback();
        return;
      }
    }

    self.offset = 0;
    callback();
  });
};

Upload.prototype.makeRequest = function (reqOpts, callback) {
  if (this.encryption) {
    reqOpts.headers = reqOpts.headers || {};
    reqOpts.headers['x-goog-encryption-algorithm'] = 'AES256';
    reqOpts.headers['x-goog-encryption-key'] = this.encryption.key;
    reqOpts.headers['x-goog-encryption-key-sha256'] = this.encryption.hash;
  }

  if (this.userProject) {
    reqOpts.qs = reqOpts.qs || {};
    reqOpts.qs.userProject = this.userProject;
  }

  this.authClient.authorizeRequest(reqOpts, function (err, authorizedReqOpts) {
    if (err) return callback(wrapError('Could not authenticate request', err));

    request(authorizedReqOpts, function (err, resp, body) {
      if (err) return callback(err, resp);

      if (body && body.error) return callback(body.error, resp);

      const nonSuccess = Math.floor(resp.statusCode / 100) !== 2; // 200-299 status code
      if (nonSuccess && resp.statusCode !== RESUMABLE_INCOMPLETE_STATUS_CODE) {
        return callback(new Error(body));
      }

      callback(null, resp, body);
    });
  });
};

Upload.prototype.getRequestStream = function (reqOpts, callback) {
  const self = this;

  if (this.userProject) {
    reqOpts.qs = reqOpts.qs || {};
    reqOpts.qs.userProject = this.userProject;
  }

  this.authClient.authorizeRequest(reqOpts, function (err, authorizedReqOpts) {
    if (err) return self.destroy(wrapError('Could not authenticate request', err));

    const requestStream = request(authorizedReqOpts);
    requestStream.on('error', self.destroy.bind(self));
    requestStream.on('response', self.onResponse.bind(self));
    requestStream.on('complete', function (resp) {
      const body = resp.body;
      if (body && body.error) self.destroy(body.error);
    });

    // this makes the response body come back in the response (weird?)
    requestStream.callback = function () {};

    callback(requestStream);
  });
};

Upload.prototype.restart = function () {
  const self = this;
  this.numBytesWritten = 0;
  this.deleteConfig();
  this.createURI(function (err) {
    if (err) return self.destroy(err);
    self.startUploading();
  });
};

Upload.prototype.get = function (prop) {
  const store = this.configStore.get([this.bucket, this.file].join('/'));
  return store && store[prop];
};

Upload.prototype.set = function (props) {
  this.configStore.set([this.bucket, this.file].join('/'), props);
};

Upload.prototype.deleteConfig = function () {
  this.configStore.delete([this.bucket, this.file].join('/'));
};

/**
 * @return {bool} is the request good?
 */
Upload.prototype.onResponse = function (resp) {
  if (resp.statusCode === 404) {
    if (this.numRetries < RETRY_LIMIT) {
      this.numRetries++;
      this.startUploading();
    } else {
      this.destroy(new Error('Retry limit exceeded'));
    }
    return false;
  }

  if (resp.statusCode > 499 && resp.statusCode < 600) {
    if (this.numRetries < RETRY_LIMIT) {
      const randomMs = Math.round(Math.random() * 1000);
      const waitTime = Math.pow(2, this.numRetries) * 1000 + randomMs;

      this.numRetries++;
      setTimeout(this.continueUploading.bind(this), waitTime);
    } else {
      this.destroy(new Error('Retry limit exceeded'));
    }
    return false;
  }

  this.emit('response', resp);

  return true;
};

function upload(cfg) {
  return new Upload(cfg);
}

(upload as any).createURI = function (cfg, callback) {
  const up = new Upload(cfg);
  up.createURI(callback);
};

module.exports = upload;
