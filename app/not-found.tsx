import { ErrorView, PAGE_NOT_FOUND } from '../src/web/error.tsx';
import { currentViewer } from './_lib/serve.tsx';

export default async function NotFound() {
  return <ErrorView status={404} message={PAGE_NOT_FOUND} viewer={await currentViewer()} />;
}
