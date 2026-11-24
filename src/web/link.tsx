import Link from 'next/link';
import type { ComponentProps } from 'react';

/**
 * A link to another page of the website, followed without reloading it. Pages are never
 * fetched ahead: each one reads the database and counts against its rate limit.
 * Only pages under app/ can be reached this way; the dashboard (a workspace) and the server's
 * other addresses, such as sign-in and the images, take an ordinary link.
 */
export function PageLink(props: Omit<ComponentProps<typeof Link>, 'prefetch'>) {
  return <Link prefetch={false} {...props} />;
}
