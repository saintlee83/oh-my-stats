import { ErrorView } from '../../../src/web/error.tsx';
import { group } from '../../../src/web/pages/groups.tsx';
import { currentViewer } from '../../_lib/serve.tsx';

/** A missing group and a private one this viewer may not see answer alike, so neither is revealed. */
export default async function NotFound() {
  return <ErrorView status={404} message={group.notFound as string} viewer={await currentViewer()} />;
}
