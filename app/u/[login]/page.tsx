import { profile } from '../../../src/web/pages/profile.tsx';
import { serve } from '../../_lib/serve.tsx';

export default async function Page({ params }: { params: Promise<{ login: string }> }) {
  return serve(profile, await params);
}
