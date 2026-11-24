import { terms } from '../../src/web/pages/reading.tsx';
import { serve } from '../_lib/serve.tsx';

export default function Page() {
  return serve(terms);
}
