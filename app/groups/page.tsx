import { groups } from '../../src/web/pages/groups.tsx';
import { serve } from '../_lib/serve.tsx';

export default function Page() {
  return serve(groups);
}
