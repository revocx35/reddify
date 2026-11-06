/** Errors with an HTTP status and a message that is safe to show to the user. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export const Errors = {
  badRequest: (msg = 'Bad request.') => new AppError(400, 'bad_request', msg),
  unauthorized: (msg = 'Please sign in.') => new AppError(401, 'unauthorized', msg),
  forbidden: (msg = 'Not allowed.') => new AppError(403, 'forbidden', msg),
  notFound: (msg = 'Not found.') => new AppError(404, 'not_found', msg),
  conflict: (msg: string) => new AppError(409, 'conflict', msg),
  tooLarge: (msg = 'Request too large.') => new AppError(413, 'too_large', msg),
  rateLimited: (seconds: number) =>
    new AppError(429, 'rate_limited', `Too many attempts. Try again in ${Math.ceil(seconds)} s.`, Math.ceil(seconds)),
  unavailable: (msg = 'Temporarily unavailable.') => new AppError(503, 'unavailable', msg),
  upstream: (msg = 'Spotify did not answer.') => new AppError(502, 'upstream', msg),
};
