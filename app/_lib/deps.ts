import { env, waitUntil } from 'cloudflare:workers';
import { isLocalRequest, type Deps } from '../../src/server/app.ts';

/** What the server needs from Cloudflare, for one request: the database, rate limits, the edge cache. */
export function depsFor(request: Request): Deps {
  return {
    db: env.DB,
    githubClientId: env.GITHUB_CLIENT_ID,
    githubClientSecret: env.GITHUB_CLIENT_SECRET ?? '',
    allowAnyGitHubToken: env.ALLOW_ANY_GITHUB_TOKEN === 'true' && isLocalRequest(request),
    fetch: (input, init) => fetch(input, init),
    waitUntil,
    // The browser's CacheStorage type, which React's components need, hides the Workers one.
    cache: (caches as CacheStorage & { default: Cache }).default,
    allow: async (kind, key) => {
      const limiter = kind === 'strict' ? env.RATE_LIMIT_STRICT : env.RATE_LIMIT_PUBLIC;
      return (await limiter.limit({ key })).success;
    },
    now: () => new Date(),
  };
}
