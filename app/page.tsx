import { landing } from '../src/web/pages/landing.tsx';
import { serve } from './_lib/serve.tsx';

export default function Page() {
  return serve(landing);
}
