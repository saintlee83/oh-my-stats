import { group } from '../../../src/web/pages/groups.tsx';
import { serve } from '../../_lib/serve.tsx';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return serve(group, await params);
}
