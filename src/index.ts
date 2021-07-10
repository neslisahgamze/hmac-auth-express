import crypto from 'crypto';
import { Request, RequestHandler, NextFunction } from 'express';

import stringToBuffer from './stringToBuffer';
import validateArguments from './validateArguments';
import AuthError from './errors';

export type Options = {
    algorithm: string;
    identifier: string;
    header: string;
    maxInterval: number;
    minInterval: number;
}

const defaults: Options = {
    algorithm: 'sha256',
    identifier: 'HMAC',
    header: 'authentication',
    maxInterval: 60 * 5,
    minInterval: 0 
}

export { AuthError };

export function HMAC(secret: string, options: Partial<Options> = {}): RequestHandler {
    const mergedOpts: Options = { ...defaults, ...options };

    const error: TypeError | void = validateArguments(secret, mergedOpts);
    if (error instanceof TypeError) {
        throw error;
    }

    return function(request: Request, _, next: NextFunction): void {
        if (!(mergedOpts.header in request.headers)) {
            return next(new AuthError(`Header provided not in sent headers. Expected ${mergedOpts.header} but not found in request.headers`));
        }

        // see https://github.com/microsoft/TypeScript/issues/41612
        // for why we can't do request.headers[options.header] in the conditional
        const header: string | string[] | undefined = request.headers[mergedOpts.header];
        if (typeof header !== 'string' || typeof mergedOpts.identifier !== 'string' || !header.startsWith(mergedOpts.identifier)) {
            return next(new AuthError(`Header did not start with correct identifier. Expected ${mergedOpts.identifier} but not found in options.header`));
        }

        const unixRegex = /(\d{1,13}):/;
        const unixMatch: RegExpExecArray | null = unixRegex.exec(header);
        if (!Array.isArray(unixMatch) || unixMatch.length !== 2 || typeof unixMatch[1] !== 'string') {
            return next(new AuthError('Unix timestamp was not present in header'));
        }

        // is the unix timestamp difference to current timestamp larger than maxInterval or smaller than minInterval
        const timeDiff: number = Math.floor(Date.now() / 1000) - Math.floor(parseInt(unixMatch[1], 10) / 1000);
        if (timeDiff > mergedOpts.maxInterval || (timeDiff * -1) > mergedOpts.minInterval) {
            return next(new AuthError('Time difference between generated and requested time is too great'));
        }

        // check HMAC digest exists in header
        const hashRegex = /:(.{1,}$)/;
        const hashMatch: RegExpExecArray | null = hashRegex.exec(header);
        if (!Array.isArray(hashMatch) || hashMatch.length !== 2 || typeof hashMatch[1] !== 'string') {
            return next(new AuthError('HMAC digest was not present in header'));
        }

        const hmac: crypto.Hmac = crypto.createHmac(mergedOpts.algorithm, secret);

        hmac.update(unixMatch[1]); // add timestamp provided in header to make sure it hasn't been changed
        hmac.update(request.method); // add verb e.g POST, GET
        hmac.update(request.originalUrl); // add url e.g /api/order

        // if we have a request body, create a md5 hash of it and add it to the hmac
        if (typeof request.body === 'object' && request.body !== null && ((!Array.isArray(request.body) && Object.keys(request.body).length > 0) || request.body.length > 0)) {
            const hash = crypto.createHash('md5');
            hash.update(JSON.stringify(request.body)); // we add it as a json string
            hmac.update(hash.digest('hex'));
        }

        const hmacDigest: Buffer = hmac.digest(); // returns Uint8Array buffer
        const sourceDigest: Buffer = stringToBuffer(hashMatch[1]); // convert string to buffer

        // use timing safe check to prevent timing attacks
        if (hmacDigest.length !== sourceDigest.length || !crypto.timingSafeEqual(hmacDigest, sourceDigest)) {
            return next(new AuthError('HMAC\'s did not match'));
        }

        return next();
    }
}