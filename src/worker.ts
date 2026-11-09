import { handle, isLocalRequest } from './server/app.ts';

export default {
  fetch(request, env, ctx) {
    return handle(request, {
      db: env.DB,
      githubClientId: env.GITHUB_CLIENT_ID,
      githubClientSecret: env.GITHUB_CLIENT_SECRET ?? '',
      allowAnyGitHubToken: env.ALLOW_ANY_GITHUB_TOKEN === 'true' && isLocalRequest(request),
      fetch: (input, init) => fetch(input, init),
      waitUntil: (work) => ctx.waitUntil(work),
      cache: caches.default,
      allow: async (kind, key) => {
        const limiter = kind === 'strict' ? env.RATE_LIMIT_STRICT : env.RATE_LIMIT_PUBLIC;
        return (await limiter.limit({ key })).success;
      },
      now: () => new Date(),
    });
  },
} satisfies ExportedHandler<Env>;
