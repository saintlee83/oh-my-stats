import { me } from '../../src/web/pages/dashboard.tsx';
import { serve } from '../_lib/serve.tsx';

export default function Page() {
  return serve(me);
}
