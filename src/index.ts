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
import {GoogleAuth, GoogleAuthOptions, JWT} from 'google-auth-library';
import * as Pumpify from 'pumpify';
import {PassThrough, Transform} from 'stream';
import * as streamEvents from 'stream-events';

const TERMINATED_UPLOAD_STATUS_CODE = 410;
const RESUMABLE_INCOMPLETE_STATUS_CODE = 308;
const RETRY_LIMIT = 5;

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
   */
  authClient?: GoogleAuth;

  /**
   * Where the gcs-resumable-upload configuration file should be stored on your
   * system. This maps to the configstore option by the same name.
   */
  configPath?: string;

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

export class Upload extends Pumpify {
  bucket: string;
  file: string;
  apiEndpoint: string;
  baseURI: string;
  authConfig?: {scopes?: string[]};
  authClient: GoogleAuth;
  cacheKey: string;
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
  private bufferStream?: PassThrough;
  private offsetStream?: PassThrough;

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

    this.uriProvidedManually = !!cfg.uri;
    this.uri = cfg.uri || this.get('uri');
    this.numBytesWritten = 0;
    this.numRetries = 0;

    const contentLength = cfg.metadata
      ? Number(cfg.metadata.contentLength)
      : NaN;
    this.contentLength = isNaN(contentLength) ? '*' : contentLength;

    this.once('writing', () => {
      if (this.uri) {
        this.continueUploading();
      } else {
        this.createURI(err => {
          if (err) {
            return this.destroy(err);
          }
          this.startUploading();
        });
      }
    });
  }

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
      reqOpts.headers![
        'X-Upload-Content-Length'
      ] = metadata.contentLength.toString();
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

    const resp = await this.makeRequest(reqOpts);
    const uri = resp.headers.location;
    this.uri = uri;
    this.set({uri});
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

  private async startUploading() {
    // The buffer stream allows us to keep chunks in memory
    // until we are sure we can successfully resume the upload.
    const bufferStream = this.bufferStream || new PassThrough();
    this.bufferStream = bufferStream;

    // The offset stream allows us to analyze each incoming
    // chunk to analyze it against what the upstream API already
    // has stored for this upload.
    const offsetStream = (this.offsetStream = new Transform({
      transform: this.onChunk.bind(this),
    }));

    // The delay stream gives us a chance to catch the response
    // from the API request before we signal to the user that
    // the upload was successful.
    const delayStream = new PassThrough();

    // The request library (authClient.request()) requires the
    // stream to be sent within the request options.
    const requestStreamEmbeddedStream = new PassThrough();

    delayStream.on('prefinish', () => {
      // Pause the stream from finishing so we can process the
      // response from the API.
      this.cork();
    });

    // Process the API response to look for errors that came in
    // the response body.
    this.on('response', (resp: GaxiosResponse) => {
      if (resp.data.error) {
        this.destroy(resp.data.error);
        return;
      }

      if (resp.status < 200 || resp.status > 299) {
        this.destroy(new Error('Upload failed'));
        return;
      }
      if (resp && resp.data) {
        resp.data.size = Number(resp.data.size);
      }
      this.emit('metadata', resp.data);
      this.deleteConfig();

      // Allow the stream to continue naturally so the user's
      // "finish" event fires.
      this.uncork();
    });

    this.setPipeline(bufferStream, offsetStream, delayStream);

    this.pipe(requestStreamEmbeddedStream);

    this.once('restart', () => {
      // The upload is being re-attempted. Disconnect the request
      // stream, so it won't receive more data.
      this.unpipe(requestStreamEmbeddedStream);
    });

    const reqOpts: GaxiosOptions = {
      method: 'PUT',
      url: this.uri,
      headers: {
        'Content-Range': 'bytes ' + this.offset + '-*/' + this.contentLength,
      },
      body: requestStreamEmbeddedStream,
    };

    try {
      await this.makeRequestStream(reqOpts);
    } catch (e) {
      this.destroy(e);
    }
  }

  private onChunk(
    chunk: string,
    enc: string,
    next: (err?: Error, data?: string) => void
  ) {
    const offset = this.offset!;
    const numBytesWritten = this.numBytesWritten;

    this.emit('progress', {
      bytesWritten: this.numBytesWritten,
      contentLength: this.contentLength,
    });

    // check if this is the same content uploaded previously. this caches a
    // slice of the first chunk, then compares it with the first byte of
    // incoming data
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
          this.bufferStream!.unshift(chunk);
          this.bufferStream!.unpipe(this.offsetStream);
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
      reqOpts.headers[
        'x-goog-encryption-key-sha256'
      ] = this.encryption.hash.toString();
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
    this.numBytesWritten = 0;
    this.deleteConfig();
    this.createURI(err => {
      if (err) {
        return this.destroy(err);
      }
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
    if (resp.status === 404) {
      if (this.numRetries < RETRY_LIMIT) {
        this.numRetries++;
        this.startUploading();
      } else {
        this.destroy(new Error('Retry limit exceeded - ' + resp.data));
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
        this.destroy(new Error('Retry limit exceeded - ' + resp.data));
      }
      return false;
    }

    this.emit('response', resp);
    return true;
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
  // If the user has specified a STORAGE_EMULAT_RHOST
  if (process.env.STORAGE_EMULATOR_HOST) {
    // then we stub out auth using a fake private key
    cfg.authClient = new JWT({
      key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDDgeS/97CpIPJS\nML2aeeDtzy7UY4zTqvoob81vpQ7DXqRHc+GN0tFVVDrlpTsc31PV7M5uj5+AfKct\n9rWihXYsBQ4rGDs6JLXkMbEIpvwkqb9On1jAsDlM5VS951cccJidca5n1ZEexIbd\nakCPwM93wsjQdhGJgfsy5nRzqc6v3zeuKTLHp4GnuDy2sJ2e0H3F9fvLehusWnxn\n5FWlkHmp3om/qK98W4RiqqmWom025rOJPQ2OBKyT0jvxQ984flnZvAathmtjCj8p\nNWHMDLnChIy27pq9YcBzYCd6Euna0CX18yrmVtK52UTB3tjb7lt+Lg4XSSbVmUX5\nEP0BxaYLAgMBAAECggEAQ0tMj38UQcLjZcL9IFTfRTvRJK33ZUwuuwhwsAMiZ8EF\nzspmUsjD4RkTBMSw6ik81B+klo29Gx7M9Jc8weoqWNCMpey7RjIooZkxFIdVttDu\n1oMmq3x83Kj7WDpu0402GstserUaNHr06PWPr2twfgp/0LEzLB+fdU+5ua4zRHl3\n4Lvbx4RlhPS/Mep3cot9HM5S1XARNTNm6EQXP4qGyLD6Ec/iRrqc3hjB0UAfLc7v\ndHmk+tfwXTC44K7jLrAjsGNPfOYO9M087RkoEXuA9MiFj0nKv0uzC5SBrH9gnWKU\nJksYuGk2KtZqfoe96QfLixHuY0Xnaz2IsxdjhnGd0QKBgQD5w4s05i4QZLlqDT0l\nsXWnbXB47G+xmNMjxzCEV5nlfDm1dSrA1B51g4xlP8NR7X4yRU4nkCJoHPbSD8Kf\nthG6uJTjpbFn91wh/VZSi91zgwbvtKX7cMga4wiabszwWpjVnsJtxBKWcTeYvCgl\nvTiP7FA2rcfavaT/4rIefIfFNQKBgQDIY4zN4jLdlFDe+pjKJafUXigjwCmXwETd\nhdFaGpRjQJk+wP5lg8EXZci5BlfTyrZF/MP2Nu8OC/EQ2NwmuqcP7YdIbtYgjcql\nsLdZZQyt21Wj0fgR7f5q8g7QvOlEakb1FqvWCcEnSdPuSXYwjsqf5A78mVMONVvX\nUZYPusVmPwKBgQCyfG1UxlGQ4YonIYLbFvBPT8QahkxjjCUG4mfni3qtJpNO+4Yr\n+uoxbGq+SEzalW+jmSd62mPcJyazgxPAcqpE13d/H3+iHoE2wQYZQ15kF/SzBFPB\nVh2KKUiSpC/Ma9Hghu3G52GpJQtoGL5QCeML5wKDsLirtu7c9jH322JjKQKBgQCI\n/Eyn/cap5Jb4JzVFk0JMkeU8s0N7oosxKCZ6QwtHYkSgOoxt1wirtv/lRCnL9Zpu\n86D+coUvBAjSbHzq2NQVtlmxsVsdu/BZHhnouYRWYUcFCydbEmfGshxgo5OPGlvR\ndaMYWWi6M+T10zBBd4uai+uW0DWP0/gplHNR42rIPwKBgBfNEo6WWSl0hQQN54YJ\nn9pGZZweKBka+sRmsYZIWD5rp0Kcgi0j0GH3w1SOVMhmKV1gAM2l9xBgC5yqMvZ3\nNDaaS7BikTfCBlm9cUJ49XsMHxmA38nJi0rUnZqkDqjAJZgNwMZK5eW7Xf3JjRuR\ntiZwD2dJIbIXNdNWetbqAnSN\n-----END PRIVATE KEY-----\n"
    });
    // and set the apiEndpoint to the host (even though this may be redudant)
    cfg.apiEndpoint = process.env.STORAGE_EMULATOR_HOST;
  }

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
