import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { Document } from '../src/web/document.tsx';
import { isWorkspace, PAGE_URL_HEADER } from '../src/web/routes.ts';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const address = (await headers()).get(PAGE_URL_HEADER);
  return <Document workspace={address ? isWorkspace(new URL(address).pathname) : false}>{children}</Document>;
}
