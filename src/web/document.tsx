import type { ReactNode } from 'react';
import { STYLE } from '../server/style.ts';

/**
 * The document around every page. The shared stylesheet is inside it, as on the server's other
 * pages. The signed-in dashboard is a workspace, whose own styles key off the body.
 */
export function Document({ workspace, children }: { workspace: boolean; children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body className={workspace ? 'workspace' : undefined}>{children}</body>
    </html>
  );
}
