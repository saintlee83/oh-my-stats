import { ErrorView } from '../../../src/web/error.tsx';
import { profile } from '../../../src/web/pages/profile.tsx';
import { currentViewer } from '../../_lib/serve.tsx';

export default async function NotFound() {
  return <ErrorView status={404} message={profile.notFound ?? ''} viewer={await currentViewer()} />;
}
