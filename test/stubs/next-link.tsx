import type { AnchorHTMLAttributes } from 'react';

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean; replace?: boolean; scroll?: boolean };

/**
 * Next's link draws an ordinary anchor on the server; following it without a reload is the
 * browser's part. The attributes keep the order they were given in.
 */
export default function Link(props: LinkProps) {
  const { prefetch: _prefetch, replace: _replace, scroll: _scroll, ...anchor } = props;
  return <a {...anchor} />;
}
