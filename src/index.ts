import axios, {AxiosError, AxiosRequestConfig, AxiosResponse} from 'axios';
import * as ConfigStore from 'configstore';
import * as crypto from 'crypto';
import * as extend from 'extend';
import {Readable, Stream} from 'stream';
import * as through from 'through2';
import * as util from 'util';

const streamEvents = require('stream-events');
const googleAuth = require('google-auto-auth');
const pumpify = require('pumpify');

// tslint:disable-next-line no-any
export type RequestBody = any;
export type RequestResponse = AxiosResponse;
export type RequestOptions = AxiosRequestConfig;
export type RequestCallback =
    (err: Error|null, response?: AxiosResponse, body?: RequestBody) => void;
export type AuthorizeRequestCallback =
    (err: Error|null, authorizedReqOpts: RequestOptions) => void;

type OldRequestOptions = {
  uri?: string,
  json?: boolean,
  // tslint:disable-next-line no-any
  qs?: any
};

const BASE_URI = 'https://www.googleapis.com/upload/storage/v1/b';
const TERMINATED_UPLOAD_STATUS_CODE = 410;
const RESUMABLE_INCOMPLETE_STATUS_CODE = 308;
const RETRY_LIMIT = 5;

const wrapError = (message: string, err: Error) => {
  return new Error([message, err.message].join('\n'));
};

interface UploadConfig {
  /**
   * The name of the destination bucket.
   */
  bucket: string;

  /**
   * The name of the destination file.
   */
  file: string;
  authConfig?: {scopes?: string[];};
  /**
   * If you want to re-use an auth client from google-auto-auth, pass an
   * instance here.
   */
  authClient?: {};

  /**
   * This will cause the upload to fail if the current generation of the remote
   * object does not match the one provided here.
   */
  generation?: number;

  /**
   * A customer-supplied encryption key. See
   * https://cloud.google.com/storage/docs/encryption#customer-supplied.
   */
  key?: string|Buffer;

  /**
   * Any metadata you wish to set on the object.
   */
  metadata?: {
    /**
     * Set the length of the file being uploaded.
     */
    contentLength?: number;

    /**
     * Set the content type of the incoming data.
     */
    contentType?: string;
  };

  /**
   * The starting byte of the upload stream, for resuming an interrupted upload.
   * See
   * https://cloud.google.com/storage/docs/json_api/v1/how-tos/resumable-upload#resume-upload.
   */
  offset?: number;

  /**
   * Set an Origin header when creating the resumable upload URI.
   */
  origin?: string;

  /**
   * Apply a predefined set of access controls to the created file.
   */
  predefinedAcl?: 'authenticatedRead'|'bucketOwnerFullControl'|
      'bucketOwnerRead'|'private'|'projectPrivate'|'publicRead';

  /**
   * Make the uploaded file private. (Alias for config.predefinedAcl =
   * 'private')
   */
  private?: boolean;

  /**
   * Make the uploaded file public. (Alias for config.predefinedAcl =
   * 'publicRead')
   */
  public?: boolean;

  /**
   * If you already have a resumable URI from a previously-created resumable
   * upload, just pass it in here and we'll use that.
   */
  uri?: string;

  /**
   * If the bucket being accessed has requesterPays functionality enabled, this
   * can be set to control which project is billed for the access of this file.
   */
  userProject?: string;
}

function Upload(cfg: UploadConfig) {
  pumpify.call(this);
  streamEvents.call(this);

  cfg = cfg || {};

  if (!cfg.bucket || !cfg.file) {
    throw new Error('A bucket and file name are required');
  }

  cfg.authConfig = cfg.authConfig || {};
  cfg.authConfig.scopes =
      ['https://www.googleapis.com/auth/devstorage.full_control'];
  this.authClient = cfg.authClient || googleAuth(cfg.authConfig);

  this.bucket = cfg.bucket;
  this.file = cfg.file;
  this.generation = cfg.generation;
  this.metadata = cfg.metadata || {};
  this.offset = cfg.offset;
  this.origin = cfg.origin;
  this.userProject = cfg.userProject;

  if (cfg.key) {
    /**
     * NOTE: This is `as string` because there appears to be some weird kind
     * of TypeScript bug as 2.8. Tracking the issue here:
     * https://github.com/Microsoft/TypeScript/issues/23155
     */
    const base64Key = Buffer.from(cfg.key as string).toString('base64');
    this.encryption = {
      key: base64Key,
      hash: crypto.createHash('sha256').update(cfg.key).digest('base64')
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

  const contentLength = cfg.metadata ? Number(cfg.metadata.contentLength) : NaN;
  this.contentLength = isNaN(contentLength) ? '*' : contentLength;

  this.once('writing', () => {
    if (this.uri) {
      this.continueUploading();
    } else {
      this.createURI((err: Error) => {
        if (err) {
          return this.destroy(err);
        }
        this.startUploading();
      });
    }
  });
}

util.inherits(Upload, pumpify);

Upload.prototype.createURI = function(
    callback: (err: Error|null, uri?: string) => void) {
  const metadata = this.metadata;

  const reqOpts: RequestOptions = {
    method: 'POST',
    url: [BASE_URI, this.bucket, 'o'].join('/'),
    params: {name: this.file, uploadType: 'resumable'},
    data: metadata,
    headers: {}
  };

  if (metadata.contentLength) {
    reqOpts.headers!['X-Upload-Content-Length'] = metadata.contentLength;
  }

  if (metadata.contentType) {
    reqOpts.headers!['X-Upload-Content-Type'] = metadata.contentType;
  }

  if (typeof this.generation !== 'undefined') {
    reqOpts.params.ifGenerationMatch = this.generation;
  }

  if (this.predefinedAcl) {
    reqOpts.params.predefinedAcl = this.predefinedAcl;
  }

  if (this.origin) {
    reqOpts.headers!.Origin = this.origin;
  }

  this.makeRequest(reqOpts, (err: Error, resp: RequestResponse) => {
    if (err) {
      return callback(err);
    }
    const uri = resp.headers.location;
    this.uri = uri;
    this.set({uri});
    this.offset = 0;

    callback(null, uri);
  });
};

Upload.prototype.continueUploading = function() {
  if (typeof this.offset === 'number') {
    return this.startUploading();
  }
  this.getAndSetOffset(this.startUploading.bind(this));
};

Upload.prototype.startUploading = function() {
  const reqOpts = {
    method: 'PUT',
    url: this.uri,
    headers:
        {'Content-Range': `bytes ${this.offset}-*/${this.contentLength}`}
  };

  const bufferStream = this.bufferStream = through();
  const offsetStream = this.offsetStream = through(this.onChunk.bind(this));
  const delayStream = through();

  this.getRequestStream(reqOpts, (requestStream: Stream) => {
    this.setPipeline(bufferStream, offsetStream, requestStream, delayStream);

    // wait for "complete" from request before letting the stream finish
    delayStream.on('prefinish', () => {
      this.cork();
    });

    requestStream.on('complete', resp => {
      if (resp.statusCode < 200 || resp.statusCode > 299) {
        this.destroy(new Error('Upload failed'));
        return;
      }

      this.emit('metadata', resp.body);
      this.deleteConfig();
      this.uncork();
    });
  });
};

Upload.prototype.onChunk = function(
    chunk: string, enc: string,
    next: (err: Error|null, data?: string) => void) {
  const offset = this.offset;
  const numBytesWritten = this.numBytesWritten;

  // check if this is the same content uploaded previously. this caches a slice
  // of the first chunk, then compares it with the first byte of incoming data
  if (numBytesWritten === 0) {
    let cachedFirstChunk = this.get('firstChunk');
    const firstChunk = chunk.slice(0, 16).valueOf();

    if (!cachedFirstChunk) {
      // This is a new upload. Cache the first chunk.
      this.set({uri: this.uri, firstChunk});
    } else {
      // this continues an upload in progress. check if the bytes are the same
      cachedFirstChunk = Buffer.from(cachedFirstChunk);
      const nextChunk = Buffer.from(firstChunk);
      if (Buffer.compare(cachedFirstChunk, nextChunk) !== 0) {
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

Upload.prototype.getAndSetOffset = function(callback: () => void) {
  this.makeRequest(
      {
        method: 'PUT',
        url: this.uri,
        headers: {'Content-Length': 0, 'Content-Range': 'bytes */*'}
      },
      (err: Error|null, resp: RequestResponse) => {
        if (err) {
          // we don't return a 404 to the user if they provided the resumable
          // URI. if we're just using the configstore file to tell us that this
          // file exists, and it turns out that it doesn't (the 404), that's
          // probably stale config data.
          if (resp && resp.status === 404 && !this.uriProvidedManually) {
            return this.restart();
          }

          // this resumable upload is unrecoverable (bad data or service error).
          //  -
          //  https://github.com/stephenplusplus/gcs-resumable-upload/issues/15
          //  -
          //  https://github.com/stephenplusplus/gcs-resumable-upload/pull/16#discussion_r80363774
          if (resp && resp.status === TERMINATED_UPLOAD_STATUS_CODE) {
            return this.restart();
          }

          return this.destroy(err);
        }

        if (resp.status === RESUMABLE_INCOMPLETE_STATUS_CODE) {
          if (resp.headers.range) {
            const range = resp.headers.range as string;
            this.offset = Number(range.split('-')[1]) + 1;
            callback();
            return;
          }
        }

        this.offset = 0;
        callback();
      });
};

Upload.prototype.makeRequest = function(
    reqOpts: RequestOptions, callback: RequestCallback) {
  if (this.encryption) {
    reqOpts.headers = reqOpts.headers || {};
    reqOpts.headers['x-goog-encryption-algorithm'] = 'AES256';
    reqOpts.headers['x-goog-encryption-key'] = this.encryption.key;
    reqOpts.headers['x-goog-encryption-key-sha256'] = this.encryption.hash;
  }

  if (this.userProject) {
    reqOpts.params = reqOpts.params || (reqOpts as OldRequestOptions).qs || {};
    reqOpts.params.userProject = this.userProject;
  }

  const oldOpts = getRequestOpts(reqOpts);

  this.authClient.authorizeRequest(
      oldOpts, (err: Error, authorizedReqOpts: RequestOptions) => {
        if (err) {
          err = wrapError('Could not authenticate request', err);
          return callback(err, null!, null);
        }
        const opts = getAxiosOpts(
            extend<RequestOptions, RequestOptions>(true, authorizedReqOpts, {
              validateStatus: status => {
                return (status >= 200 && status < 300) ||
                    status === RESUMABLE_INCOMPLETE_STATUS_CODE;
              }
            }));
        axios.request(authorizedReqOpts)
            .then(
                res => {
                  callback(null, res, res.data);
                },
                err => {
                  const body = err.response ? err.response.data : undefined;
                  return callback(err, err.response, body);
                });
      });
};

Upload.prototype.getRequestStream = function(
    reqOpts: RequestOptions, callback: (requestStream: Readable) => void) {

  if (this.userProject) {
    reqOpts.params = reqOpts.params || {};
    reqOpts.params.userProject = this.userProject;
  }
  const opts = getRequestOpts(reqOpts);
  this.authClient.authorizeRequest(
      reqOpts, (err: Error, authorizedReqOpts: RequestOptions) => {
        if (err) {
          return this.destroy(wrapError('Could not authenticate request', err));
        }

        const opts = getAxiosOpts(extend<RequestOptions, RequestOptions>(
            true, authorizedReqOpts, {responseType: 'stream'}));

        axios.request<Readable&{callback: Function}>(opts).then(res => {
          res.data.on('error', this.destroy.bind(this));
          res.data.on('response', this.onResponse.bind(this));
          res.data.on('complete', (resp) => {
            const body = resp.body;
            if (body && body.error) {
              this.destroy(body.error);
            }
          });
          // this makes the response body come back in the response (weird?)
          res.data.callback = () => {};
          callback(res.data);
        });
      });
};

Upload.prototype.restart = function() {
  this.numBytesWritten = 0;
  this.deleteConfig();
  this.createURI((err: Error) => {
    if (err) {
      return this.destroy(err);
    }
    this.startUploading();
  });
};

Upload.prototype.get = function(prop: string) {
  const store = this.configStore.get([this.bucket, this.file].join('/'));
  return store && store[prop];
};

// tslint:disable-next-line no-any
Upload.prototype.set = function(props: any) {
  this.configStore.set([this.bucket, this.file].join('/'), props);
};

Upload.prototype.deleteConfig = function() {
  this.configStore.delete([this.bucket, this.file].join('/'));
};

/**
 * @return {bool} is the request good?
 */
Upload.prototype.onResponse = function(resp: RequestResponse) {
  if (resp.status === 404) {
    if (this.numRetries < RETRY_LIMIT) {
      this.numRetries++;
      this.startUploading();
    } else {
      this.destroy(new Error('Retry limit exceeded'));
    }
    return false;
  }

  if (resp.status > 499 && resp.status < 600) {
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

function upload(cfg: UploadConfig) {
  // tslint:disable-next-line no-any
  return new (Upload as any)(cfg);
}

/**
 * Given a set of request or axios request options, translate into Mikeal
 * request format.
 * @param opts The Request options to be normalized
 */
function getRequestOpts(opts: RequestOptions&OldRequestOptions) {
  if (opts.url && !opts.uri) {
    opts.uri = opts.url;
  }
  if (opts.params && !opts.qs) {
    opts.qs = opts.params;
  }
  return opts;
}

/**
 * Given a set of request or axios request options, translate into Axios request
 * format.
 * @param opts The Request options to be normalized
 */
function getAxiosOpts(opts: RequestOptions&OldRequestOptions) {
  if (opts.uri && !opts.url) {
    opts.url = opts.uri;
  }
  if (opts.qs && !opts.params) {
    opts.params = opts.qs;
  }
  return opts;
}

// tslint:disable-next-line no-any
(upload as any).createURI =
    (cfg: UploadConfig, callback: (err: Error|null, uri?: string) => void) => {
      // tslint:disable-next-line no-any
      const up = new (Upload as any)(cfg);
      up.createURI(callback);
    };

module.exports = upload;
