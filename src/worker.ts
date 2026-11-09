import { handle } from './server/app.ts';

export default {
  fetch(request, env, ctx) {
    return handle(request, {
      db: env.DB,
      githubClientId: env.GITHUB_CLIENT_ID,
      githubClientSecret: env.GITHUB_CLIENT_SECRET ?? '',
      allowAnyGitHubToken: env.ALLOW_ANY_GITHUB_TOKEN === 'true',
      fetch: (input, init) => fetch(input, init),
      waitUntil: (work) => ctx.waitUntil(work),
      now: () => new Date(),
    });
  },
} satisfies ExportedHandler<Env>;
