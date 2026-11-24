import { handle } from '../../src/server/app.ts';
import { depsFor } from '../_lib/deps.ts';

// Every GET address that isn't a page under app/ is answered by the server as before: the
// API `oms` calls, the images and badges, sign-in, robots.txt and the sitemap, and the 404 page
// for addresses nothing serves. The proxy hands the server everything else that isn't a GET.
export const dynamic = 'force-dynamic';

const server = (request: Request) => handle(request, depsFor(request));

export { server as GET, server as HEAD };
