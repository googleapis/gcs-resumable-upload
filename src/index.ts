/*!
 * Copyright 2018 Google LLC
 *
 * Use of this source code is governed by an MIT-style
 * license that can be found in the LICENSE file or at
 * https://opensource.org/licenses/MIT.
 */

import AbortController from 'abort-controller';
import * as ConfigStore from 'configstore';
import {createHash} from 'crypto';
import * as extend from 'extend';
import {GaxiosOptions, GaxiosPromise, GaxiosResponse} from 'gaxios';
import * as gaxios from 'gaxios';
import {GoogleAuth, GoogleAuthOptions} from 'google-auth-library';
import * as Pumpify from 'pumpify';
import {Duplex, PassThrough, pipeline, Readable, Transform} from 'stream';
import * as streamEvents from 'stream-events';
import retry = require('async-retry');

const TERMINATED_UPLOAD_STATUS_CODE = 410;
const RESUMABLE_INCOMPLETE_STATUS_CODE = 308;
const RETRY_LIMIT = 5;
const DEFAULT_API_ENDPOINT_REGEX = /.*\.googleapis\.com/;
const MAX_RETRY_DELAY = 64;
const RETRY_DELAY_MULTIPLIER = 2;
const MAX_TOTAL_RETRY_TIMEOUT = 600;
const AUTO_RETRY_VALUE = true;

export const PROTOCOL_REGEX = /^(\w*):\/\//;

export interface ErrorWithCode extends Error {
  code: number;
}

export type CreateUriCallback = (err: Error | null, uri?: string) => void;

export interface Encryption {
  key: {};
  hash: {};
}

export type PredefinedAcl =
  | 'authenticatedRead'
  | 'bucketOwnerFullControl'
  | 'bucketOwnerRead'
  | 'private'
  | 'projectPrivate'
  | 'publicRead';

export interface QueryParameters {
  contentEncoding?: string;
  ifGenerationMatch?: number;
  ifGenerationNotMatch?: number;
  ifMetagenerationMatch?: number;
  ifMetagenerationNotMatch?: number;
  kmsKeyName?: string;
  predefinedAcl?: PredefinedAcl;
  projection?: 'full' | 'noAcl';
  userProject?: string;
}

export interface UploadConfig {
  /**
   * The API endpoint used for the request.
   * Defaults to `storage.googleapis.com`.
   * **Warning**:
   * If this value does not match the pattern *.googleapis.com,
   * an emulator context will be assumed and authentication will be bypassed.
   */
  apiEndpoint?: string;

  /**
   * The name of the destination bucket.
   */
  bucket: string;

  /**
   * The name of the destination file.
   */
  file: string;

  /**
   * The GoogleAuthOptions passed to google-auth-library
   */
  authConfig?: GoogleAuthOptions;

  /**
   * If you want to re-use an auth client from google-auto-auth, pass an
   * instance here.
   * Defaults to GoogleAuth and gets automatically overridden if an
   * emulator context is detected.
   */
  authClient?: {
    request: <T = any>(
      opts: GaxiosOptions
    ) => Promise<GaxiosResponse<T>> | GaxiosPromise<T>;
  };

  /**
   * Where the gcs-resumable-upload configuration file should be stored on your
   * system. This maps to the configstore option by the same name.
   */
  configPath?: string;

  /**
   * Create a separate request per chunk.
   *
   * Should be a multiple of 256 KiB (2^18).
   * We recommend using at least 8 MiB for the chunk size.
   *
   * @link https://cloud.google.com/storage/docs/performing-resumable-uploads#chunked-upload
   */
  chunkSize?: number;

  /**
   * For each API request we send, you may specify custom request options that
   * we'll add onto the request. The request options follow the gaxios API:
   * https://github.com/googleapis/gaxios#request-options.
   */
  customRequestOptions?: GaxiosOptions;

  /**
   * This will cause the upload to fail if the current generation of the remote
   * object does not match the one provided here.
   */
  generation?: number;

  /**
   * A customer-supplied encryption key. See
   * https://cloud.google.com/storage/docs/encryption#customer-supplied.
   */
  key?: string | Buffer;

  /**
   * Resource name of the Cloud KMS key, of the form
   * `projects/my-project/locations/global/keyRings/my-kr/cryptoKeys/my-key`,
   * that will be used to encrypt the object. Overrides the object metadata's
   * `kms_key_name` value, if any.
   */
  kmsKeyName?: string;

  /**
   * Any metadata you wish to set on the object.
   */
  metadata?: ConfigMetadata;

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
   * Specify query parameters that go along with the initial upload request. See
   * https://cloud.google.com/storage/docs/json_api/v1/objects/insert#parameters
   */
  params?: QueryParameters;

  /**
   * Apply a predefined set of access controls to the created file.
   */
  predefinedAcl?: PredefinedAcl;

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

  /**
   * Configuration options for retrying retriable errors.
   */
  retryOptions?: RetryOptions;
}

export interface ConfigMetadata {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;

  /**
   * Set the length of the file being uploaded.
   */
  contentLength?: number;

  /**
   * Set the content type of the incoming data.
   */
  contentType?: string;
}

export interface RetryOptions {
  retryDelayMultiplier?: number;
  totalTimeout?: number;
  maxRetryDelay?: number;
  autoRetry?: boolean;
  maxRetries?: number;
  retryableErrorFn?: (err: ApiError) => boolean;
}

export interface GoogleInnerError {
  reason?: string;
}

export interface ApiError extends Error {
  code?: number;
  errors?: GoogleInnerError[];
}

export class Upload extends Pumpify {
  bucket: string;
  file: string;
  apiEndpoint: string;
  baseURI: string;
  authConfig?: {scopes?: string[]};
  /*
   * Defaults to GoogleAuth and gets automatically overridden if an
   * emulator context is detected.
   */
  authClient: {
    request: <T = any>(
      opts: GaxiosOptions
    ) => Promise<GaxiosResponse<T>> | GaxiosPromise<T>;
  };
  cacheKey: string;
  chunkSize?: number;
  customRequestOptions: GaxiosOptions;
  generation?: number;
  key?: string | Buffer;
  kmsKeyName?: string;
  metadata: ConfigMetadata;
  offset?: number;
  origin?: string;
  params: QueryParameters;
  predefinedAcl?: PredefinedAcl;
  private?: boolean;
  public?: boolean;
  uri?: string;
  userProject?: string;
  encryption?: Encryption;
  configStore: ConfigStore;
  uriProvidedManually: boolean;
  numBytesWritten = 0;
  numRetries = 0;
  contentLength: number | '*';
  retryLimit: number = RETRY_LIMIT;
  maxRetryDelay: number = MAX_RETRY_DELAY;
  retryDelayMultiplier: number = RETRY_DELAY_MULTIPLIER;
  maxRetryTotalTimeout: number = MAX_TOTAL_RETRY_TIMEOUT;
  timeOfFirstRequest: number;
  retryableErrorFn?: (err: ApiError) => boolean;
  private offsetStream?: PassThrough;
  private upstreamChunkBuffer: Buffer = Buffer.alloc(0);
  private chunkBufferEncoding?: BufferEncoding = undefined;
  /**
   * A chunk used for caching the most recent multi-chunk upload chunk.
   * We should not assume that the server received all bytes sent in the request.
   *  - https://cloud.google.com/storage/docs/performing-resumable-uploads#chunked-upload
   */
  private multiChunkUploadChunk = Buffer.alloc(0);

  constructor(cfg: UploadConfig) {
    super();
    streamEvents(this);

    cfg = cfg || {};

    if (!cfg.bucket || !cfg.file) {
      throw new Error('A bucket and file name are required');
    }

    cfg.authConfig = cfg.authConfig || {};
    cfg.authConfig.scopes = [
      'https://www.googleapis.com/auth/devstorage.full_control',
    ];
    this.authClient = cfg.authClient || new GoogleAuth(cfg.authConfig);

    this.apiEndpoint = 'https://storage.googleapis.com';
    if (cfg.apiEndpoint) {
      this.apiEndpoint = this.sanitizeEndpoint(cfg.apiEndpoint);
      if (!DEFAULT_API_ENDPOINT_REGEX.test(cfg.apiEndpoint)) {
        this.authClient = gaxios;
      }
    }

    this.baseURI = `${this.apiEndpoint}/upload/storage/v1/b`;
    this.bucket = cfg.bucket;

    const cacheKeyElements = [cfg.bucket, cfg.file];
    if (typeof cfg.generation === 'number') {
      cacheKeyElements.push(`${cfg.generation}`);
    }

    this.cacheKey = cacheKeyElements.join('/');

    this.customRequestOptions = cfg.customRequestOptions || {};
    this.file = cfg.file;
    this.generation = cfg.generation;
    this.kmsKeyName = cfg.kmsKeyName;
    this.metadata = cfg.metadata || {};
    this.offset = cfg.offset;
    this.origin = cfg.origin;
    this.params = cfg.params || {};
    this.userProject = cfg.userProject;
    this.chunkSize = cfg.chunkSize;

    if (cfg.key) {
      /**
       * NOTE: This is `as string` because there appears to be some weird kind
       * of TypeScript bug as 2.8. Tracking the issue here:
       * https://github.com/Microsoft/TypeScript/issues/23155
       */
      const base64Key = Buffer.from(cfg.key as string).toString('base64');
      this.encryption = {
        key: base64Key,
        hash: createHash('sha256').update(cfg.key).digest('base64'),
      };
    }

    this.predefinedAcl = cfg.predefinedAcl;
    if (cfg.private) this.predefinedAcl = 'private';
    if (cfg.public) this.predefinedAcl = 'publicRead';

    const configPath = cfg.configPath;
    this.configStore = new ConfigStore('gcs-resumable-upload', null, {
      configPath,
    });

    const autoRetry = cfg?.retryOptions?.autoRetry || AUTO_RETRY_VALUE;
    this.uriProvidedManually = !!cfg.uri;
    this.uri = cfg.uri || this.get('uri');
    this.numBytesWritten = 0;
    this.numRetries = 0; //counter for number of retries currently executed

    if (autoRetry && cfg?.retryOptions?.maxRetries !== undefined) {
      this.retryLimit = cfg.retryOptions.maxRetries;
    } else if (!autoRetry) {
      this.retryLimit = 0;
    }

    if (cfg?.retryOptions?.maxRetryDelay !== undefined) {
      this.maxRetryDelay = cfg.retryOptions.maxRetryDelay;
    }

    if (cfg?.retryOptions?.retryDelayMultiplier !== undefined) {
      this.retryDelayMultiplier = cfg.retryOptions.retryDelayMultiplier;
    }

    if (cfg?.retryOptions?.totalTimeout !== undefined) {
      this.maxRetryTotalTimeout = cfg.retryOptions.totalTimeout;
    }

    this.timeOfFirstRequest = Date.now();
    this.retryableErrorFn = cfg?.retryOptions?.retryableErrorFn;

    const contentLength = cfg.metadata
      ? Number(cfg.metadata.contentLength)
      : NaN;
    this.contentLength = isNaN(contentLength) ? '*' : contentLength;

    this.once('writing', () => {
      // Now that someone is writing to this object, let's attach
      // some duplexes. These duplexes enable this object to be
      // better managed in terms of 'end'/'finish' control and
      // buffering writes downstream if someone enables multi-
      // chunk upload support (`chunkSize`) w/o adding too much into
      // memory.
      this.setPipeline(this.upstream, new PassThrough());

      if (this.uri) {
        this.continueUploading();
      } else {
        this.createURI((err, uri) => {
          if (err) {
            return this.destroy(err);
          }
          this.set({uri});
          this.startUploading();
        });
      }
    });
  }

  /** A stream representing the incoming data to upload */
  private readonly upstream = new Duplex({
    read: async () => {
      this.once('prepareFinish', () => {
        // Allows this (`Upload`) to finish/end once the upload has succeeded.
        this.upstream.push(null);
      });
    },
    write: this.writeToChunkBuffer.bind(this),
  });

  createURI(): Promise<string>;
  createURI(callback: CreateUriCallback): void;
  createURI(callback?: CreateUriCallback): void | Promise<string> {
    if (!callback) {
      return this.createURIAsync();
    }
    this.createURIAsync().then(r => callback(null, r), callback);
  }

  protected async createURIAsync(): Promise<string> {
    const metadata = this.metadata;

    const reqOpts: GaxiosOptions = {
      method: 'POST',
      url: [this.baseURI, this.bucket, 'o'].join('/'),
      params: Object.assign(
        {
          name: this.file,
          uploadType: 'resumable',
        },
        this.params
      ),
      data: metadata,
      headers: {},
    };

    if (metadata.contentLength) {
      reqOpts.headers!['X-Upload-Content-Length'] =
        metadata.contentLength.toString();
    }

    if (metadata.contentType) {
      reqOpts.headers!['X-Upload-Content-Type'] = metadata.contentType;
    }

    if (typeof this.generation !== 'undefined') {
      reqOpts.params.ifGenerationMatch = this.generation;
    }

    if (this.kmsKeyName) {
      reqOpts.params.kmsKeyName = this.kmsKeyName;
    }

    if (this.predefinedAcl) {
      reqOpts.params.predefinedAcl = this.predefinedAcl;
    }

    if (this.origin) {
      reqOpts.headers!.Origin = this.origin;
    }
    const uri = await retry(
      async (bail: (err: Error) => void) => {
        try {
          const res = await this.makeRequest(reqOpts);
          return res.headers.location;
        } catch (e) {
          const apiError = {
            code: e.response?.status,
            name: e.response?.statusText,
            message: e.response?.statusText,
            errors: [
              {
                reason: e.code as string,
              },
            ],
          };
          if (
            this.retryLimit > 0 &&
            this.retryableErrorFn &&
            this.retryableErrorFn!(apiError)
          ) {
            throw e;
          } else {
            return bail(e);
          }
        }
      },
      {
        retries: this.retryLimit,
        factor: this.retryDelayMultiplier,
        maxTimeout: this.maxRetryDelay! * 1000, //convert to milliseconds
        maxRetryTime: this.maxRetryTotalTimeout! * 1000, //convert to milliseconds
      }
    );

    this.uri = uri;
    this.offset = 0;
    return uri;
  }

  private async continueUploading() {
    if (typeof this.offset === 'number') {
      this.startUploading();
      return;
    }
    await this.getAndSetOffset();
    this.startUploading();
  }

  /**
   * A handler for `upstream` to write and buffer its data.
   *
   * @param chunk The chunk to append to the buffer
   * @param encoding The encoding of the chunk
   * @param readCallback A callback for when the buffer has been read downstream
   */
  private writeToChunkBuffer(
    chunk: Buffer,
    encoding: BufferEncoding,
    readCallback: () => void
  ) {
    this.upstreamChunkBuffer = Buffer.concat([this.upstreamChunkBuffer, chunk]);
    this.chunkBufferEncoding = encoding;

    this.once('readFromChunkBuffer', readCallback);
    process.nextTick(() => this.emit('wroteToChunkBuffer'));
  }

  private unshiftChunkBuffer(chunk: Buffer) {
    this.upstreamChunkBuffer = Buffer.concat([chunk, this.upstreamChunkBuffer]);
  }

  /**
   * Retrieves data from upstream's buffer.
   *
   * @param limit The maximum amount to return from the buffer.
   * @returns The data requested.
   */
  private pullFromChunkBuffer(limit: number) {
    const chunk = this.upstreamChunkBuffer.slice(0, limit);
    this.upstreamChunkBuffer = this.upstreamChunkBuffer.slice(limit);

    // notify upstream we've read from the buffer so it can potentially
    // send more data down.
    process.nextTick(() => this.emit('readFromChunkBuffer'));

    return chunk;
  }

  /**
   * A handler for determining if data is ready to be read from upstream.
   *
   * @returns If there will be more chunks to read in the future
   */
  private async waitForNextChunk(): Promise<boolean> {
    const willBeMoreChunks = await new Promise<boolean>(resolve => {
      // There's data available - it should be digested
      if (this.upstreamChunkBuffer.length) {
        return resolve(true);
      }

      // The upstream writable ended, we shouldn't expect any more data.
      if (this.upstream.writableEnded) {
        return resolve(false);
      }

      // Nothing immediate seems to be determined. We need to prepare some
      // listeners to determine next steps...

      const wroteToChunkBufferCallback = () => {
        removeListeners();
        return resolve(true);
      };

      const upstreamFinishedCallback = () => {
        removeListeners();

        // this should be the last chunk, if there's anything there
        if (this.upstreamChunkBuffer.length) return resolve(true);

        return resolve(false);
      };

      // Remove listeners when we're ready to callback.
      // It's important to clean-up listeners as Node has a default max number of
      // event listeners. Notably, The number of requests can be greater than the
      // number of potential listeners.
      // - https://nodejs.org/api/events.html#eventsdefaultmaxlisteners
      const removeListeners = () => {
        this.removeListener('wroteToChunkBuffer', wroteToChunkBufferCallback);
        this.upstream.removeListener('finish', upstreamFinishedCallback);
      };

      // If there's data recently written it should be digested
      this.once('wroteToChunkBuffer', wroteToChunkBufferCallback);

      // If the upstream finishes let's see if there's anything to grab
      this.upstream.once('finish', upstreamFinishedCallback);
    });

    return willBeMoreChunks;
  }

  /**
   * Reads data from upstream up to the provided `limit`.
   * Ends when the limit has reached or no data is expected to be pushed from upstream.
   *
   * @param limit The most amount of data this iterator should return. `Infinity` is fine.
   * @param multiChunkMode Determines if one chunk is returned, up to the limit, for the iterator
   */
  private async *upstreamIterator(limit: number, multiChunkMode: boolean) {
    let completeChunk = Buffer.alloc(0);

    // read from upstream chunk buffer
    while (limit && (await this.waitForNextChunk())) {
      // read until end or limit has been reached
      const chunk = this.pullFromChunkBuffer(limit);

      limit -= chunk.byteLength;
      if (multiChunkMode) {
        // return 1 chunk at the end of iteration
        completeChunk = Buffer.concat([completeChunk, chunk]);
      } else {
        // return many chunks throughout iteration
        yield {
          chunk,
          encoding: this.chunkBufferEncoding,
        };
      }
    }

    if (multiChunkMode) {
      yield {
        chunk: completeChunk,
        encoding: this.chunkBufferEncoding,
      };
    }
  }

  async startUploading() {
    const multiChunkMode = !!this.chunkSize;
    let expectedUploadSize: number | undefined = undefined;

    if (!this.offset) {
      this.offset = 0;
    }

    if (this.chunkSize && typeof this.contentLength === 'number') {
      const remainingBytesToUpload = this.contentLength - this.numBytesWritten;

      // Uploads should be no more than the `chunkSize`
      expectedUploadSize = Math.min(this.chunkSize, remainingBytesToUpload);
    }

    // A queue for the upstream data
    const upstreamQueue = this.upstreamIterator(
      expectedUploadSize || Infinity,
      multiChunkMode // multi-chunk mode should return 1 chunk per request
    );

    // The primary read stream for this request. This stream retrieves no more
    // than the exact requested amount from upstream.
    const leadStream = new Readable({
      read: async () => {
        const result = await upstreamQueue.next();

        if (result.value) {
          if (this.chunkSize) {
            // Cache the data in case the server misses some bytes in the request.
            // We should not assume that the server received all bytes sent in the request.
            // - https://cloud.google.com/storage/docs/performing-resumable-uploads#chunked-upload
            this.multiChunkUploadChunk = result.value.chunk;
          }

          if (this.numBytesWritten === 0) {
            if (!this.checkFirstChunkOfUpload(result.value.chunk)) {
              this.unshiftChunkBuffer(result.value.chunk);
              this.restart();
              leadStream.push(null);
              return;
            }
          }

          leadStream.push(result.value.chunk, result.value.encoding);
        }

        if (result.done) {
          leadStream.push(null);
        }
      },
    });

    // The offset stream allows us to analyze each incoming
    // chunk to analyze it against what the upstream API already
    // has stored for this upload.
    const offsetStream = (this.offsetStream = new Transform({
      transform: this.requestOffsetHandler.bind(this),
    }));

    // This should be 'once' as `startUploading` can be called again
    // for multi chunk uploads.
    const responseCallback = (resp: GaxiosResponse) => {
      cleanupRequestListeners();
      this.responseHandler(resp);
    };

    const restartCallback = () => {
      cleanupRequestListeners();
      // The upload is being re-attempted. Disconnect the request
      // stream so it won't receive more data.
      pipelineForRequest.unpipe(requestStreamEmbeddedStream);
    };

    // It's important to clean-up listeners as Node has a default max number of
    // event listeners. Notably, The number of requests can be greater than the
    // number of potential listeners.
    // - https://nodejs.org/api/events.html#eventsdefaultmaxlisteners
    const cleanupRequestListeners = () => {
      // remove local response handler to avoid duplicating
      // response handling
      this.removeListener('response', responseCallback);

      // Remove 'restart' if the other
      this.removeListener('restart', restartCallback);
    };

    this.once('response', responseCallback);
    this.once('restart', restartCallback);

    // The request library (authClient.request()) requires the
    // stream to be sent within the request options.
    const requestStreamEmbeddedStream = new PassThrough();

    const pipelineForRequest = pipeline(leadStream, offsetStream, error => {
      if (error) this.emit('error', error);
    });

    pipelineForRequest.pipe(requestStreamEmbeddedStream);

    let headers: GaxiosOptions['headers'] = {};

    // If using multiple chunk upload, set appropriate header
    if (multiChunkMode && expectedUploadSize) {
      const endingByte = expectedUploadSize + this.numBytesWritten - 1;
      headers = {
        'Content-Length': expectedUploadSize,
        'Content-Range': `bytes ${this.offset}-${endingByte}/${this.contentLength}`,
      };
    } else {
      headers = {
        'Content-Range': `bytes ${this.offset}-*/${this.contentLength}`,
      };
    }

    const reqOpts: GaxiosOptions = {
      method: 'PUT',
      url: this.uri,
      headers,
      body: requestStreamEmbeddedStream,
    };

    try {
      await this.makeRequestStream(reqOpts);
    } catch (e) {
      this.destroy(e);
    }
  }

  // Process the API response to look for errors that came in
  // the response body.
  responseHandler(resp: GaxiosResponse) {
    if (resp.data.error) {
      this.destroy(resp.data.error);
      return;
    }

    const shouldContinueWithNextMultiChunkRequest =
      this.chunkSize &&
      resp.status === RESUMABLE_INCOMPLETE_STATUS_CODE &&
      resp.headers.range;

    if (shouldContinueWithNextMultiChunkRequest) {
      // Use the upper value in this header to determine where to start the next chunk.
      // We should not assume that the server received all bytes sent in the request.
      // https://cloud.google.com/storage/docs/performing-resumable-uploads#chunked-upload
      const range: string = resp.headers.range;
      this.offset = Number(range.split('-')[1]) + 1;

      this.set({
        uri: this.uri,
        firstChunk: null, // A new request will be made - reset the firstChunk
      });

      // We should not assume that the server received all bytes sent in the request.
      // - https://cloud.google.com/storage/docs/performing-resumable-uploads#chunked-upload
      const missingBytes = this.numBytesWritten - this.offset - 1;
      if (missingBytes) {
        const dataToPrependForResending = this.multiChunkUploadChunk.slice(
          -missingBytes
        );
        // As multi-chunk uploads send one chunk per request AND pulls one
        // chunk into the pipeline, prepending the missing bytes back should
        // be fine for the next request.
        this.unshiftChunkBuffer(dataToPrependForResending);
      }

      // continue uploading next chunk
      this.continueUploading();
    } else if (resp.status < 200 || resp.status > 299) {
      const err: ApiError = {
        code: resp.status,
        name: 'Upload failed',
        message: 'Upload failed',
      };
      this.destroy(err);
    } else {
      // remove the multi-chunk upload chunk, if used
      this.multiChunkUploadChunk = Buffer.alloc(0);

      if (resp && resp.data) {
        resp.data.size = Number(resp.data.size);
      }
      this.emit('metadata', resp.data);
      this.deleteConfig();

      // Allow the object (Upload) to continue naturally so the user's
      // "finish" event fires.
      this.emit('prepareFinish');
    }
  }

  /**
   * Check if this is the same content uploaded previously. This caches a
   * slice of the first chunk, then compares it with the first byte of
   * incoming data.
   *
   * @param chunk The chunk to check against the cache
   * @returns if the request is ok to continue as-is
   */
  private checkFirstChunkOfUpload(chunk: Buffer) {
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
        return false;
      }
    }

    return true;
  }

  private requestOffsetHandler(
    chunk: Buffer,
    enc: BufferEncoding,
    next: (err?: Error, data?: Buffer) => void
  ) {
    const offset = this.offset!;
    const numBytesWritten = this.numBytesWritten;

    this.emit('progress', {
      bytesWritten: this.numBytesWritten,
      contentLength: this.contentLength,
    });

    let length = chunk.length;

    if (typeof chunk === 'string') {
      length = Buffer.byteLength(chunk, enc);
    }
    if (numBytesWritten < offset) {
      chunk = chunk.slice(offset - numBytesWritten);
    }

    this.numBytesWritten += length;

    // TODO: detemine how to resolve the following scenario:
    // - A request exists (byte >0)
    // - We're re-reading a file to upload (say, byte 0)
    // - We're sending the multi-chunk payload with 'Content-Length' header
    // only push data from the byte after the one we left off on
    next(undefined, this.numBytesWritten > offset ? chunk : undefined);
  }

  private async getAndSetOffset() {
    const opts: GaxiosOptions = {
      method: 'PUT',
      url: this.uri!,
      headers: {'Content-Length': 0, 'Content-Range': 'bytes */*'},
    };
    try {
      const resp = await this.makeRequest(opts);
      if (resp.status === RESUMABLE_INCOMPLETE_STATUS_CODE) {
        if (resp.headers.range) {
          const range = resp.headers.range as string;
          this.offset = Number(range.split('-')[1]) + 1;
          return;
        }
      }
      this.offset = 0;
    } catch (err) {
      const resp = err.response;
      // we don't return a 404 to the user if they provided the resumable
      // URI. if we're just using the configstore file to tell us that this
      // file exists, and it turns out that it doesn't (the 404), that's
      // probably stale config data.
      if (resp && resp.status === 404 && !this.uriProvidedManually) {
        this.restart();
        return;
      }

      // this resumable upload is unrecoverable (bad data or service error).
      //  -
      //  https://github.com/stephenplusplus/gcs-resumable-upload/issues/15
      //  -
      //  https://github.com/stephenplusplus/gcs-resumable-upload/pull/16#discussion_r80363774
      if (resp && resp.status === TERMINATED_UPLOAD_STATUS_CODE) {
        this.restart();
        return;
      }

      this.destroy(err);
    }
  }

  private async makeRequest(reqOpts: GaxiosOptions): GaxiosPromise {
    if (this.encryption) {
      reqOpts.headers = reqOpts.headers || {};
      reqOpts.headers['x-goog-encryption-algorithm'] = 'AES256';
      reqOpts.headers['x-goog-encryption-key'] = this.encryption.key.toString();
      reqOpts.headers['x-goog-encryption-key-sha256'] =
        this.encryption.hash.toString();
    }

    if (this.userProject) {
      reqOpts.params = reqOpts.params || {};
      reqOpts.params.userProject = this.userProject;
    }
    // Let gaxios know we will handle a 308 error code ourselves.
    reqOpts.validateStatus = (status: number) => {
      return (
        (status >= 200 && status < 300) ||
        status === RESUMABLE_INCOMPLETE_STATUS_CODE
      );
    };

    const combinedReqOpts = extend(
      true,
      {},
      this.customRequestOptions,
      reqOpts
    );
    const res = await this.authClient.request(combinedReqOpts);
    if (res.data && res.data.error) {
      throw res.data.error;
    }
    return res;
  }

  private async makeRequestStream(reqOpts: GaxiosOptions): GaxiosPromise {
    const controller = new AbortController();
    this.once('error', () => controller.abort());

    if (this.userProject) {
      reqOpts.params = reqOpts.params || {};
      reqOpts.params.userProject = this.userProject;
    }
    reqOpts.signal = controller.signal;
    reqOpts.validateStatus = () => true;

    const combinedReqOpts = extend(
      true,
      {},
      this.customRequestOptions,
      reqOpts
    );
    const res = await this.authClient.request(combinedReqOpts);
    this.onResponse(res);
    return res;
  }

  private restart() {
    this.emit('restart');
    this.multiChunkUploadChunk = Buffer.alloc(0);
    this.numBytesWritten = 0;
    this.deleteConfig();
    this.createURI((err, uri) => {
      if (err) {
        return this.destroy(err);
      }
      this.set({uri});
      this.startUploading();
    });
  }

  private get(prop: string) {
    const store = this.configStore.get(this.cacheKey);
    return store && store[prop];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private set(props: any) {
    this.configStore.set(this.cacheKey, props);
  }

  deleteConfig() {
    this.configStore.delete(this.cacheKey);
  }

  /**
   * @return {bool} is the request good?
   */
  private onResponse(resp: GaxiosResponse) {
    if (
      (this.retryableErrorFn &&
        this.retryableErrorFn({
          code: resp.status,
          message: resp.statusText,
          name: resp.statusText,
        })) ||
      resp.status === 404 ||
      (resp.status > 499 && resp.status < 600)
    ) {
      this.attemptDelayedRetry(resp);
      return false;
    }

    this.emit('response', resp);
    return true;
  }

  /**
   * @param resp GaxiosResponse object from previous attempt
   */
  private attemptDelayedRetry(resp: GaxiosResponse) {
    if (this.numRetries < this.retryLimit) {
      if (resp.status === 404) {
        this.startUploading();
      } else {
        const retryDelay = this.getRetryDelay();
        if (retryDelay <= 0) {
          this.destroy(
            new Error(`Retry total time limit exceeded - ${resp.data}`)
          );
          return;
        }
        setTimeout(this.continueUploading.bind(this), retryDelay);
      }
      this.numRetries++;
    } else {
      this.destroy(new Error('Retry limit exceeded - ' + resp.data));
    }
  }

  /**
   * @returns {number} the amount of time to wait before retrying the request
   */
  private getRetryDelay(): number {
    const randomMs = Math.round(Math.random() * 1000);
    const waitTime =
      Math.pow(this.retryDelayMultiplier, this.numRetries) * 1000 + randomMs;
    const maxAllowableDelayMs =
      this.maxRetryTotalTimeout * 1000 - (Date.now() - this.timeOfFirstRequest);
    const maxRetryDelayMs = this.maxRetryDelay * 1000;

    return Math.min(waitTime, maxRetryDelayMs, maxAllowableDelayMs);
  }

  /*
   * Prepare user-defined API endpoint for compatibility with our API.
   */
  private sanitizeEndpoint(url: string) {
    if (!PROTOCOL_REGEX.test(url)) {
      url = `https://${url}`;
    }
    return url.replace(/\/+$/, ''); // Remove trailing slashes
  }
}

export function upload(cfg: UploadConfig) {
  return new Upload(cfg);
}

export function createURI(cfg: UploadConfig): Promise<string>;
export function createURI(cfg: UploadConfig, callback: CreateUriCallback): void;
export function createURI(
  cfg: UploadConfig,
  callback?: CreateUriCallback
): void | Promise<string> {
  const up = new Upload(cfg);
  if (!callback) {
    return up.createURI();
  }
  up.createURI().then(r => callback(null, r), callback);
}
