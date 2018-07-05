import {AxiosRequestConfig, AxiosResponse} from 'axios';

// tslint:disable-next-line no-any
export type RequestBody = any;
export type RequestResponse = AxiosResponse;
export type RequestOptions = AxiosRequestConfig;
export type RequestCallback =
    (err: Error|null, response?: AxiosResponse, body?: RequestBody) => void;
